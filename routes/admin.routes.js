const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { ADMIN_UNAME, ADMIN_HASH, ADMIN_SECRET } = require('../config/constants');
const { adminAuth } = require('../middleware/auth');

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

router.post('/login', adminLoginLimiter, [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
], validate, (req, res) => {
  const { username, password } = req.body;
  if (username.toLowerCase().trim() !== ADMIN_UNAME.toLowerCase())
    return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, ADMIN_HASH))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ sa: true }, ADMIN_SECRET, { expiresIn: '12h' });
  res.json({ token, username: ADMIN_UNAME });
});

router.get('/accounts', adminAuth, async (req, res) => {
  try {
    const users = await db.filter('users', () => true);
    const groups = await db.filter('groups', () => true);
    const pcs = await db.filter('pcs', () => true);
    const groupByOwner = new Map();
    for (const g of groups) {
      if (!groupByOwner.has(g.owner_id)) groupByOwner.set(g.owner_id, []);
      groupByOwner.get(g.owner_id).push(g);
    }
    const pcCountByGroup = new Map();
    for (const p of pcs) {
      pcCountByGroup.set(p.group_id, (pcCountByGroup.get(p.group_id) || 0) + 1);
    }
    const result = users.map(u => {
      const userGroups = groupByOwner.get(u.id) || [];
      let pcCount = 0;
      for (const g of userGroups) pcCount += pcCountByGroup.get(g.id) || 0;
      let status = u.status || 'active';
      if (status === 'active' && u.expiry_date && Date.now() > u.expiry_date) {
        status = 'expired';
        db.update('users', x => x.id === u.id, { status: 'expired' }).catch(() => {});
      }
      return {
        id: u.id, username: u.username,
        label: u.label || '',
        status,
        price: u.price || 0,
        expiry_date: u.expiry_date || null,
        notes: u.notes || '',
        last_active: u.last_active || u.created_at || Date.now(),
        created_at: u.created_at || Date.now(),
        pc_count: pcCount,
        group_count: userGroups.length
      };
    });
    result.sort((a, b) => {
      const o = { pending: 0, active: 1, deactivated: 2, expired: 3 };
      return (o[a.status] ?? 1) - (o[b.status] ?? 1);
    });
    res.json(result);
  } catch(e) {
    console.error('[ERROR] /api/admin/accounts:', e);
    res.status(500).json({ error: e.message });
  }
});

const ALLOWED_UPDATES = new Set(['label', 'status', 'price', 'expiry_date', 'notes']);
const VALID_STATUSES = new Set(['pending', 'active', 'deactivated', 'expired']);

router.patch('/accounts/:id', adminAuth, [
  body('label').optional().isString().trim().isLength({ max: 200 }).withMessage('Label max 200 characters'),
  body('status').optional().isIn([...VALID_STATUSES]).withMessage('Invalid status'),
  body('price').optional().isFloat({ min: 0, max: 999999 }).withMessage('Price must be a valid positive number'),
  body('expiry_date').optional().isNumeric().withMessage('Expiry date must be a valid timestamp'),
  body('notes').optional().isString().trim().isLength({ max: 1000 }).withMessage('Notes max 1000 characters'),
], validate, async (req, res) => {
  try {
    const updates = {};
    for (const field of ALLOWED_UPDATES) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'No valid fields to update' });
    await db.update('users', u => u.id === req.params.id, updates);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/accounts/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string')
      return res.status(400).json({ error: 'Invalid account ID' });
    const groups = await db.filter('groups', g => g.owner_id === id);
    for (const g of groups) {
      const pcs = await db.filter('pcs', p => p.group_id === g.id);
      for (const pc of pcs) {
        await db.delete('installed_apps', a => a.pc_id === pc.id);
        await db.delete('sessions', s => s.pc_id === pc.id);
      }
      await db.delete('pcs', p => p.group_id === g.id);
      await db.delete('group_members', m => m.group_id === g.id);
    }
    await db.delete('groups', g => g.owner_id === id);
    await db.delete('users', u => u.id === id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
