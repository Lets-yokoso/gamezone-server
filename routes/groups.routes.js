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
    const group = await db.insert('groups', { id, name, owner_id: req.user.id, created_at: Date.now(), hourly_rate: 5 });
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

router.get('/:groupId/history/export', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const format = req.query.format || 'text';
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const group = await db.get('groups', g => g.id === groupId);
    const hourlyRate = group?.hourly_rate || 5;
    const pcs = await db.filter('pcs', p => p.group_id === groupId);
    const rows = [];
    let totalSessionMins = 0;
    let totalFreeMins = 0;
    for (const pc of pcs) {
      const pcHistory = pc.time_history || [];
      const parentEntries = pcHistory.filter(h => h.type === 'session' && (!h.parentId || h.parentId === null));
      let pcSessionMins = 0;
      let pcFreeMins = 0;
      for (const entry of parentEntries) {
        if (entry.mode === 'free') {
          pcFreeMins += entry.mins || 0;
        } else {
          pcSessionMins += entry.mins || 0;
        }
      }
      rows.push({ pcName: pc.name, sessionMins: pcSessionMins, freeMins: pcFreeMins });
      totalSessionMins += pcSessionMins;
      totalFreeMins += pcFreeMins;
    }
    const estimatedIncome = (totalSessionMins / 60) * hourlyRate;
    const groupName = group?.name || 'Unknown';
    if (format === 'text') {
      let text = `GameZone History Report - ${groupName}\n`;
      text += `${'='.repeat(50)}\n\n`;
      text += `Hourly Rate: $${hourlyRate.toFixed(2)}\n\n`;
      text += '--- PC Details ---\n';
      text += `${'-'.repeat(40)}\n`;
      for (const row of rows) {
        const income = (row.sessionMins / 60) * hourlyRate;
        text += `${row.pcName}\n`;
        text += `  Session: ${row.sessionMins}m | Free Timer: ${row.freeMins}m | Income: $${income.toFixed(2)}\n`;
      }
      text += `${'-'.repeat(40)}\n`;
      text += `\n--- Total Summary ---\n`;
      text += `Total Session: ${totalSessionMins}m (${(totalSessionMins/60).toFixed(1)} hrs)\n`;
      text += `Total Free Timer: ${totalFreeMins}m (${(totalFreeMins/60).toFixed(1)} hrs)\n`;
      text += `Estimated Total Income: $${estimatedIncome.toFixed(2)}\n`;
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${groupName.replace(/[^a-z0-9]/gi, '_')}_history.txt"`);
      res.send(text);
    } else if (format === 'excel') {
      let csv = 'PC Name,Session (mins),Free Timer (mins),Income\n';
      for (const row of rows) {
        const income = (row.sessionMins / 60) * hourlyRate;
        csv += `"${row.pcName}",${row.sessionMins},${row.freeMins},${income.toFixed(2)}\n`;
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${groupName.replace(/[^a-z0-9]/gi, '_')}_history.csv"`);
      res.send(csv);
    } else {
      res.status(400).json({ error: 'Invalid format. Use text or excel.' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
