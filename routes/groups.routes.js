const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const db = require('../db');
const { authMiddleware, accountCheck } = require('../middleware/auth');
const { canManageGroup } = require('../middleware/permissions');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

router.use(authMiddleware, accountCheck);

router.post('/', [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Group name must be 1-100 characters'),
], validate, async (req, res) => {
  try {
    const { name } = req.body;
    const id = uuidv4();
    const group = await db.insert('groups', { id, name, owner_id: req.user.id, created_at: Date.now(), hourly_rate: 5, flush_time: '03:30', group_suffix: Math.random().toString(36).substr(2, 5) });
    res.json(group);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const owned = await db.filter('groups', g => g.owner_id === req.user.id);
    const memberGroupIds = (await db.filter('group_members', m => m.user_id === req.user.id)).map(m => m.group_id);
    const membered = await db.filter('groups', g => memberGroupIds.includes(g.id));
    const all = [...owned, ...membered].filter((g, i, arr) => arr.findIndex(x => x.id === g.id) === i);
    res.json(all);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:groupId', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const group = await db.get('groups', g => g.id === groupId && g.owner_id === req.user.id);
    if (!group) return res.status(403).json({ error: 'Only owner can delete this group' });
    const pcIds = (await db.filter('pcs', p => p.group_id === groupId)).map(p => p.id);
    await db.delete('installed_apps', a => pcIds.includes(a.pc_id));
    await db.delete('sessions', s => pcIds.includes(s.pc_id));
    await db.delete('pcs', p => p.group_id === groupId);
    await db.delete('group_members', m => m.group_id === groupId);
    await db.delete('groups', g => g.id === groupId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:groupId/admins', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  body('username').trim().isLength({ min: 1, max: 100 }).withMessage('Username is required'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const group = await db.get('groups', g => g.id === groupId && g.owner_id === req.user.id);
    if (!group) return res.status(403).json({ error: 'Only owner can add admins' });
    const user = await db.get('users', u => u.username.toLowerCase() === req.body.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.insertOrIgnore('group_members', { id: uuidv4(), group_id: groupId, user_id: user.id, role: 'admin' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:groupId', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const group = await db.get('groups', g => g.id === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    res.json(group);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:groupId/admins', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const members = await db.filter('group_members', m => m.group_id === groupId);
    const admins = await Promise.all(members.map(async m => {
      const u = await db.get('users', u => u.id === m.user_id);
      return u ? { id: u.id, username: u.username, role: m.role } : null;
    }));
    res.json(admins.filter(Boolean));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:groupId/admins/:userId', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  param('userId').isUUID().withMessage('Invalid user ID'),
], validate, async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const group = await db.get('groups', g => g.id === groupId && g.owner_id === req.user.id);
    if (!group) return res.status(403).json({ error: 'Only owner can remove admins' });
    const remainingAdmins = await db.filter('group_members', m => m.group_id === groupId && m.user_id !== userId);
    if (remainingAdmins.length === 0) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }
    await db.delete('group_members', m => m.group_id === groupId && m.user_id === userId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:groupId/rate', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  body('hourly_rate').isFloat({ min: 0, max: 99999 }).withMessage('Rate must be a number'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { hourly_rate } = req.body;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    await db.update('groups', g => g.id === groupId, { hourly_rate });
    if (global.setCachedRate) {
      global.setCachedRate(groupId, hourly_rate);
    }
    res.json({ success: true, hourly_rate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:groupId/flush-time', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  body('flush_time').matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).withMessage('Invalid time format (HH:MM)'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { flush_time } = req.body;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    await db.update('groups', g => g.id === groupId, { flush_time });
    res.json({ success: true, flush_time });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:groupId/flush-time', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const group = await db.get('groups', g => g.id === groupId);
    res.json({ flush_time: group?.flush_time || '03:30' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fast endpoint using in-memory cache (no DB query)
router.get('/:groupId/rate', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const rate = global.getCachedRate ? global.getCachedRate(groupId) : 5;
    res.json({ hourly_rate: rate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function roundDownTo5(minutes) {
  return Math.floor(minutes / 5) * 5;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

router.get('/:groupId/history/export', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const group = await db.get('groups', g => g.id === groupId);
    const hourlyRate = group?.hourly_rate || 5;
    const pcs = await db.filter('pcs', p => p.group_id === groupId);
    const rows = [];
    let totalSessionMins = 0;
    let totalFreeMins = 0;
    let totalRoundedDown = 0;
    let totalRoundedSession = 0;
    let totalRoundedFree = 0;
    for (const pc of pcs) {
      const pcHistory = pc.time_history || [];
      const parentEntries = pcHistory.filter(h => h.type === 'session' && (!h.parentId || h.parentId === null));
      let pcSessionMins = 0;
      let pcFreeMins = 0;
      let pcRoundedDown = 0;
      let pcSessionRounded = 0;
      let pcFreeRounded = 0;
      for (const entry of parentEntries) {
        const entryMins = entry.mins || 0;
        const rounded = roundDownTo5(entryMins);
        const lost = entryMins - rounded;
        if (entry.mode === 'free') {
          pcFreeMins += entryMins;
          pcFreeRounded += rounded;
          pcRoundedDown += lost;
        } else {
          pcSessionMins += entryMins;
          pcSessionRounded += rounded;
          pcRoundedDown += lost;
        }
      }
      const pcTotalRounded = pcSessionRounded + pcFreeRounded;
      const pcIncome = (pcTotalRounded / 60) * hourlyRate;
      rows.push({ pcName: pc.name, sessionMins: pcSessionMins, freeMins: pcFreeMins, roundedDownMins: pcRoundedDown, income: pcIncome });
      totalSessionMins += pcSessionMins;
      totalFreeMins += pcFreeMins;
      totalRoundedDown += pcRoundedDown;
      totalRoundedSession += pcSessionRounded;
      totalRoundedFree += pcFreeRounded;
    }
    const totalRoundedMins = totalRoundedSession + totalRoundedFree;
    const estimatedIncome = (totalRoundedMins / 60) * hourlyRate;
    const groupName = group?.name || 'Unknown';
    const today = new Date().toISOString().split('T')[0];
    const safeName = groupName.replace(/[^a-z0-9]/gi, '_');
    const ua = req.headers['user-agent'] || '';
    const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(ua);
    
    if (isMobile) {
      const html = '<!DOCTYPE html>\n' +
        '<html>\n<head>\n' +
        '<meta charset="UTF-8">\n' +
        '<title>GameZone History - ' + escapeHtml(groupName) + '</title>\n' +
        '<style>\n' +
        'body { font-size: 15px; font-family: "Segoe UI", Arial, sans-serif; padding: 30px; color: #333; background: #fff; line-height: 1.8; }\n' +
        'h2 { font-size: 22px; margin-bottom: 10px; color: #111; }\n' +
        '.meta { color: #666; font-size: 13px; margin-bottom: 30px; }\n' +
        'table { border-collapse: collapse; width: 100%; margin: 20px 0; }\n' +
        'th { background: #f0f0f0; padding: 12px 15px; text-align: left; border: 1px solid #ddd; font-weight: 600; }\n' +
        'td { padding: 10px 15px; border: 1px solid #ddd; }\n' +
        'tr:nth-child(even) { background: #f9f9f9; }\n' +
        '.summary { margin-top: 30px; padding: 20px; background: #f8f8f8; border-radius: 8px; border: 1px solid #ddd; }\n' +
        '.summary p { margin: 5px 0; }\n' +
        '.total { font-size: 18px; font-weight: 700; color: #111; margin-top: 10px; }\n' +
        '</style>\n' +
        '</head>\n<body>\n' +
        '<h2>GameZone History Report - ' + escapeHtml(groupName) + '</h2>\n' +
        '<div class="meta">Hourly Rate: Rs ' + hourlyRate.toFixed(2) + ' | Date: ' + today + '</div>\n' +
        '<table>\n' +
        '<tr><th>PC Name</th><th>Session Time (min)</th><th>Free Timer (min)</th><th>Rounded Down (min)</th><th>Income (Rs)</th></tr>\n' +
        rows.map(row =>
          '<tr><td>' + escapeHtml(row.pcName) + '</td><td>' + row.sessionMins + '</td><td>' + row.freeMins + '</td><td>' + row.roundedDownMins + '</td><td>Rs ' + row.income.toFixed(2) + '</td></tr>'
        ).join('\n') +
        '\n</table>\n' +
        '<div class="summary">\n' +
        '<p>Total Session Time: ' + totalSessionMins + 'm (' + (totalSessionMins / 60).toFixed(1) + ' hrs)</p>\n' +
        '<p>Total Free Timer: ' + totalFreeMins + 'm (' + (totalFreeMins / 60).toFixed(1) + ' hrs)</p>\n' +
        '<p>Total Rounded Down: ' + totalRoundedDown + 'm</p>\n' +
        '<p class="total">Estimated Total Income: Rs ' + estimatedIncome.toFixed(2) + '</p>\n' +
        '</div>\n' +
        '</body>\n</html>';
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_history_' + today + '.txt"');
      res.send(html);
    } else {
      const colW = { pc: 14, session: 15, free: 16, rounded: 19, income: 12 };
      const pad = (str, len) => String(str).padEnd(len);
      let text = 'GameZone History Report - ' + groupName + '\n';
      text += 'Hourly Rate: Rs ' + hourlyRate.toFixed(2) + ' | Date: ' + today + '\n\n';
      text += pad('PC Name', colW.pc) + ' | ' + pad('Session (min)', colW.session) + ' | ' + pad('Free Timer (min)', colW.free) + ' | ' + pad('Rounded Down (min)', colW.rounded) + ' | ' + pad('Income (Rs)', colW.income) + '\n';
      for (const row of rows) {
        text += pad(row.pcName, colW.pc) + ' | ' + pad(row.sessionMins, colW.session) + ' | ' + pad(row.freeMins, colW.free) + ' | ' + pad(row.roundedDownMins, colW.rounded) + ' | ' + pad(row.income.toFixed(2), colW.income) + '\n';
      }
      text += '\nTotal Session: ' + totalSessionMins + 'm | Total Free: ' + totalFreeMins + 'm | Total Rounded Down: ' + totalRoundedDown + 'm\n';
      text += 'Estimated Total Income: Rs ' + estimatedIncome.toFixed(2) + '\n';
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '_history_' + today + '.txt"');
      res.send(text);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
