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
    const group = await db.insert('groups', { id, name, owner_id: req.user.id, created_at: Date.now() });
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

module.exports = router;
