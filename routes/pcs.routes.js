const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const db = require('../db');
const { authMiddleware, accountCheck } = require('../middleware/auth');
const { canManageGroup } = require('../middleware/permissions');
const { _pendingProcs } = require('../sockets/socketCache');

const MAX_FREE_TIME_MINUTES = 600;

const getPcHistory = async (pcId) => {
  const pc = await db.get('pcs', p => p.id === pcId);
  return pc?.time_history || [];
};

const setPcHistory = async (pcId, history) => {
  await db.update('pcs', p => p.id === pcId, { time_history: history });
};

const getChildEntries = async (pcId, parentId) => {
  const history = await getPcHistory(pcId);
  return history.filter(h => h.parentId === parentId);
};

const calculateParentMins = (parentEntry, childEntries, remainingSeconds = 0) => {
  let total = parentEntry.mins || 0;
  for (const child of childEntries) {
    if (child.type === 'add') total += child.mins;
    else if (child.type === 'remove') total += child.mins;
  }
  if (remainingSeconds > 0) {
    const remainingMins = Math.floor(remainingSeconds / 60);
    total -= remainingMins;
  }
  return Math.max(0, total);
};

const addHistoryEntry = async (pcId, entry) => {
  const history = await getPcHistory(pcId);
  const newHistory = [entry, ...history];
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  const filtered = newHistory.filter(h => h.at > cutoff);
  await setPcHistory(pcId, filtered);
  return filtered;
};

const updateHistoryEntry = async (pcId, entryId, updates) => {
  const history = await getPcHistory(pcId);
  const idx = history.findIndex(h => h.id === entryId);
  if (idx >= 0) {
    history[idx] = { ...history[idx], ...updates };
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    const filtered = history.filter(h => h.at > cutoff);
    await setPcHistory(pcId, filtered);
  }
};

const updateParentMins = async (pcId, parentId, newMins) => {
  const history = await getPcHistory(pcId);
  const idx = history.findIndex(h => h.id === parentId);
  if (idx >= 0) {
    history[idx] = { ...history[idx], mins: newMins };
    await setPcHistory(pcId, history);
  }
};

const SAFE_PATH_REGEX = /^[a-zA-Z0-9\s\-_\.\\\/:]+$/;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

router.use(authMiddleware, accountCheck);

router.get('/groups/:groupId/pcs', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const pcs = (await db.filter('pcs', p => p.group_id === groupId))
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map(p => ({ ...p, password: undefined }));
    res.json(pcs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/groups/:groupId/pcs', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('PC name must be 1-100 characters'),
  body('password').isLength({ min: 1, max: 128 }).withMessage('Password must be 1-128 characters'),
  body('price_per_hour').optional().isFloat({ min: 0, max: 99999 }).withMessage('Invalid price'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const { name, password, price_per_hour } = req.body;
    const id = uuidv4();
    const existingPcs = await db.filter('pcs', p => p.group_id === groupId);
    const maxOrder = existingPcs.reduce((m, p) => Math.max(m, p.order || 0), 0);
    await db.insert('pcs', {
      id, group_id: groupId, name,
      password: bcrypt.hashSync(password, 10),
      is_online: 0, session_end: 0, stopwatch_start: 0,
      payment_status: null,
      price_per_hour: price_per_hour || 0,
      order: maxOrder + 1,
      time_history: []
    });
    res.json({ id, name, group_id: groupId, is_online: 0, session_end: 0, stopwatch_start: 0, payment_status: null, price_per_hour: price_per_hour || 0, order: maxOrder + 1, time_history: [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/groups/:groupId/pcs/:pcId', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const { groupId, pcId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    await db.delete('installed_apps', a => a.pc_id === pcId);
    await db.delete('sessions', s => s.pc_id === pcId);
    await db.delete('pcs', p => p.id === pcId && p.group_id === groupId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/groups/:groupId/pcs/reorder', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  body('order').isArray({ min: 1 }).withMessage('Order must be a non-empty array'),
  body('order.*.pc_id').isUUID().withMessage('Invalid PC ID'),
  body('order.*.order').isInt({ min: 0 }).withMessage('Order must be a non-negative integer'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { order } = req.body;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    for (const item of order)
      await db.update('pcs', p => p.id === item.pc_id, { order: item.order });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/payment', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
  body('payment_status').optional({ values: 'falsy' }).isIn(['paid', 'unpaid']).withMessage('Payment status must be paid or unpaid'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { pcId } = req.params;
    const { payment_status } = req.body;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    await db.update('pcs', p => p.id === pcId, { payment_status });
    io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, payment_status });
    res.json({ success: true, payment_status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/session/start', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
  body('duration_minutes').isInt({ min: 1, max: 1440 }).withMessage('Duration must be 1-1440 minutes'),
], validate, async (req, res) => {
  try {
    const session_id = uuidv4();
    const io = req.app.get('io');
    const { pcId } = req.params;
    const { duration_minutes } = req.body;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const session_end = Math.floor(Date.now() / 1000) + duration_minutes * 60;
    await db.update('pcs', p => p.id === pcId, { session_end, stopwatch_start: 0 });
    const price = pc.price_per_hour > 0 ? (duration_minutes / 60) * pc.price_per_hour : 0;
    await db.insert('sessions', { id: uuidv4(), pc_id: pcId, started_at: Math.floor(Date.now() / 1000), duration_minutes, price, ended_at: null });
    addHistoryEntry(pcId, { id: uuidv4(), type: 'session', mode: 'paid', mins: duration_minutes, at: Date.now(), status: 'active', session_id });
    const remaining = duration_minutes * 60;
    io.to(`pc:${pcId}`).emit('session:start', { session_end, duration_minutes, remaining_seconds: remaining });
    io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, session_end, stopwatch_start: 0, payment_status: pc.payment_status });
    res.json({ success: true, session_end, remaining_seconds: remaining, session_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/session/add-time', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
  body('minutes').isInt({ min: -1440, max: 1440 }).withMessage('Minutes must be between -1440 and 1440'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { pcId } = req.params;
    const { minutes } = req.body;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const now = Math.floor(Date.now() / 1000);
    if (pc.stopwatch_start > 0 && minutes > 0) {
      const new_start = pc.stopwatch_start - (minutes * 60);
      await db.update('pcs', p => p.id === pcId, { stopwatch_start: new_start });
      io.to(`pc:${pcId}`).emit('session:stopwatch', { started_at: new_start });
      io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, session_end: 0, stopwatch_start: new_start, payment_status: pc.payment_status });
      return res.json({ success: true, stopwatch_start: new_start });
    }
    const current_end = pc.session_end > now ? pc.session_end : now;
    const new_end = current_end + minutes * 60;
if (minutes < 0 && new_end <= now) {
      const parentHistory = await getPcHistory(pcId);
      const activeSession = parentHistory.find(h => h.type === 'session' && h.status === 'active');
      if (activeSession) {
        await addHistoryEntry(pcId, { mins: minutes, at: Date.now(), type: 'remove', parentId: activeSession.id });
        const childEntries = parentHistory.filter(h => h.parentId === activeSession.id);
        const remainingSeconds = activeSession.mode === 'paid' && pc.session_end > now ? pc.session_end - now : 0;
        const finalMins = calculateParentMins(activeSession, childEntries, remainingSeconds);
        await updateHistoryEntry(pcId, activeSession.id, { mins: finalMins, status: 'ended' });
      }
      await db.update('pcs', p => p.id === pcId, { session_end: 0, stopwatch_start: 0 });
      await db.update('sessions', s => s.pc_id === pcId && !s.ended_at, { ended_at: now });
      io.to(`pc:${pcId}`).emit('session:end', {});
      io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, session_end: 0, stopwatch_start: 0 });
      return res.json({ success: true, session_ended: true });
    }

    const parentHistory = await getPcHistory(pcId);
    const activeSession = parentHistory.find(h => h.type === 'session' && h.status === 'active');
    if (activeSession) {
      await addHistoryEntry(pcId, { mins: minutes, at: Date.now(), type: minutes > 0 ? 'add' : 'remove', parentId: activeSession.id });
      const newMins = (activeSession.mins || 0) + minutes;
      await updateParentMins(pcId, activeSession.id, newMins);
    }
    await db.update('pcs', p => p.id === pcId, { session_end: new_end });
    const rem = new_end - now;
    io.to(`pc:${pcId}`).emit('session:add-time', { session_end: new_end, added_minutes: minutes, remaining_seconds: rem });
    io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, session_end: new_end, stopwatch_start: 0, payment_status: pc.payment_status });
    res.json({ success: true, session_end: new_end, remaining_seconds: rem });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/session/end', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { pcId } = req.params;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const parentHistory = await getPcHistory(pcId);
    const activeSession = parentHistory.find(h => h.type === 'session' && h.status === 'active');
    if (activeSession) {
      const now = Math.floor(Date.now() / 1000);
      const remainingSeconds = activeSession.mode === 'paid' && pc.session_end > now ? pc.session_end - now : 0;
      const finalMins = activeSession.mins - Math.floor(remainingSeconds / 60);
      await updateHistoryEntry(pcId, activeSession.id, { mins: finalMins, status: 'ended' });
    }
    await db.update('pcs', p => p.id === pcId, { session_end: 0, stopwatch_start: 0 });
    await db.update('sessions', s => s.pc_id === pcId && !s.ended_at, { ended_at: Math.floor(Date.now() / 1000) });
    io.to(`pc:${pcId}`).emit('session:end', {});
    io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, session_end: 0, stopwatch_start: 0 });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/session/stopwatch', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const session_id = uuidv4();
    const io = req.app.get('io');
    const { pcId } = req.params;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const started_at = Math.floor(Date.now() / 1000);
    await db.update('pcs', p => p.id === pcId, { session_end: 0, stopwatch_start: started_at });
    await addHistoryEntry(pcId, { id: uuidv4(), type: 'session', mode: 'free', mins: 0, at: Date.now(), status: 'active', session_id });
    io.to(`pc:${pcId}`).emit('session:stopwatch', { started_at });
    io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, session_end: 0, stopwatch_start: started_at });
    res.json({ success: true, started_at, session_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/session/stopwatch-end', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { pcId } = req.params;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const now = Math.floor(Date.now() / 1000);
    const elapsed = pc.stopwatch_start > 0 ? Math.floor((now - pc.stopwatch_start) / 60) : 0;
    const parentHistory = await getPcHistory(pcId);
    const activeFreeSession = parentHistory.find(h => h.type === 'session' && h.mode === 'free' && h.status === 'active');
    if (activeFreeSession) {
      await updateHistoryEntry(pcId, activeFreeSession.id, { mins: elapsed, status: 'ended' });
    }
    await db.update('pcs', p => p.id === pcId, { session_end: 0, stopwatch_start: 0 });
    io.to(`pc:${pcId}`).emit('session:stopwatch-end', {});
    io.to(`pc:${pcId}`).emit('command:lock', {});
    io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pcId, session_end: 0, stopwatch_start: 0 });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

let _stopwatchCheckInterval = null;
const startStopwatchCheck = () => {
  if (_stopwatchCheckInterval) return;
  _stopwatchCheckInterval = setInterval(async () => {
    try {
      const allPcs = await db.filter('pcs', p => p.stopwatch_start > 0);
      const now = Math.floor(Date.now() / 1000);
      const io = global._io;
      if (!io) return;
      for (const pc of allPcs) {
        const elapsed = Math.floor((now - pc.stopwatch_start) / 60);
        if (elapsed >= MAX_FREE_TIME_MINUTES) {
          const parentHistory = await getPcHistory(pc.id);
          const activeFreeSession = parentHistory.find(h => h.type === 'session' && h.mode === 'free' && h.status === 'active');
          if (activeFreeSession) {
            await updateHistoryEntry(pc.id, activeFreeSession.id, { mins: elapsed, status: 'ended', auto_ended: true });
          }
          await db.update('pcs', p => p.id === pc.id, { session_end: 0, stopwatch_start: 0 });
          io.to(`pc:${pc.id}`).emit('session:stopwatch-end', {});
          io.to(`pc:${pc.id}`).emit('command:lock', {});
          io.to(`group:${pc.group_id}`).emit('group:'+pc.group_id+':pc-session', { pc_id: pc.id, session_end: 0, stopwatch_start: 0 });
        }
      }
    } catch(e) {}
  }, 60000);
};
global._startStopwatchCheck = startStopwatchCheck;

router.post('/pcs/:pcId/lock', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const pc = await db.get('pcs', p => p.id === req.params.pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    io.to(`pc:${req.params.pcId}`).emit('command:lock', {});
    console.log(`[CMD] Lock sent to PC ${req.params.pcId}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/unlock', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const pc = await db.get('pcs', p => p.id === req.params.pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    io.to(`pc:${req.params.pcId}`).emit('command:unlock', {});
    console.log(`[CMD] Unlock sent to PC ${req.params.pcId}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/sleep', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { pcId } = req.params;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    io.to(`pc:${pcId}`).emit('command:sleep', {});
    console.log(`[CMD] Sleep sent to PC ${pcId}`);
    res.json({ success: true });
  } catch(e) { console.error('Sleep error:', e); res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/shutdown', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const { pcId } = req.params;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    io.to(`pc:${pcId}`).emit('command:shutdown', {});
    console.log(`[CMD] Shutdown sent to PC ${pcId}`);
    res.json({ success: true });
  } catch(e) { console.error('Shutdown error:', e); res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/processes', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const pcId = req.params.pcId;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const requestId = require('crypto').randomBytes(8).toString('hex');
    if (!_pendingProcs[pcId]) _pendingProcs[pcId] = {};
    _pendingProcs[pcId][requestId] = { res };
    const timeout = setTimeout(() => {
      if (_pendingProcs[pcId] && _pendingProcs[pcId][requestId]) {
        delete _pendingProcs[pcId][requestId];
        if (Object.keys(_pendingProcs[pcId]).length === 0) delete _pendingProcs[pcId];
        res.json({ processes: [] });
      }
    }, 6000);
    io.to(`pc:${pcId}`).emit('command:get-processes', { requestId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/kill-process', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
  body('pid').isInt({ min: 1 }).withMessage('Invalid process ID'),
  body('name').trim().isLength({ min: 1, max: 500 }).withMessage('Process name is required'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const pcId = req.params.pcId;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const { pid, name } = req.body;
    io.to(`pc:${pcId}`).emit('command:kill-process', { pid, name });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pcs/:pcId/launch', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
  body('app_path').trim().isLength({ min: 1, max: 1000 }).withMessage('App path is required')
    .matches(SAFE_PATH_REGEX).withMessage('App path contains invalid characters'),
], validate, async (req, res) => {
  try {
    const io = req.app.get('io');
    const pcId = req.params.pcId;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const { app_path } = req.body;
    io.to(`pc:${pcId}`).emit('command:launch', { app_path });
    console.log(`[CMD] Launch '${app_path}' sent to PC ${pcId}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/pcs/:pcId/apps', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const pc = await db.get('pcs', p => p.id === req.params.pcId);
    if (!pc) return res.status(404).json({ error: 'PC not found' });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    res.json(await db.filter('installed_apps', a => a.pc_id === req.params.pcId));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/pcs/:pcId/history', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
], validate, async (req, res) => {
  try {
    const { pcId } = req.params;
    const pc = await db.get('pcs', p => p.id === pcId);
    if (!pc) return res.json({ history: [] });
    if (!await canManageGroup(req.user.id, pc.group_id)) return res.status(403).json({ error: 'Forbidden' });
    const historyData = pc.time_history || [];
    const filtered = historyData.filter(h => h.parentId === undefined || h.parentId === null || h.parentId === '');
    res.json({ history: filtered });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/groups/:groupId/history', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
  try {
    const { groupId } = req.params;
    if (!await canManageGroup(req.user.id, groupId)) return res.status(403).json({ error: 'Forbidden' });
    const pcs = await db.filter('pcs', p => p.group_id === groupId);
    for (const pc of pcs) {
      await db.update('pcs', p => p.id === pc.id, { time_history: [] });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
