const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { JWT_SECRET } = require('../config/constants');
const { authMiddleware } = require('../middleware/auth');

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

const authLimiter = rateLimit({
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

router.post('/register', authLimiter, [
  body('username')
    .trim()
    .isLength({ min: 3, max: 32 })
    .withMessage('Username must be 3-32 characters')
    .matches(USERNAME_REGEX)
    .withMessage('Username can only contain letters, numbers, underscores, dots, and hyphens'),
  body('password')
    .isLength({ min: 6, max: 128 })
    .withMessage('Password must be 6-128 characters'),
], validate, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (await db.get('users', u => u.username.toLowerCase() === username.toLowerCase()))
      return res.status(400).json({ error: 'Username already taken' });
    const id = uuidv4();
    await db.insert('users', {
      id, username,
      password: bcrypt.hashSync(password, 10),
      status: 'pending',
      label: '', price: 0, expiry_date: null, notes: '',
      last_active: Date.now(),
      created_at: Date.now()
    });
    const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username }, status: 'pending', expiry_date: null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/login', authLimiter, [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
], validate, async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.get('users', u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    let status = user.status || 'active';
    if (status === 'active' && user.expiry_date && Date.now() > user.expiry_date) {
      status = 'expired';
      await db.update('users', u => u.id === user.id, { status: 'expired', last_active: Date.now() });
    } else {
      await db.update('users', u => u.id === user.id, { last_active: Date.now() });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username }, status, expiry_date: user.expiry_date || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await db.get('users', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    let status = user.status || 'active';
    if (status === 'active' && user.expiry_date && Date.now() > user.expiry_date) {
      status = 'expired';
      await db.update('users', u => u.id === user.id, { status: 'expired' });
    }
    res.json({ status, expiry_date: user.expiry_date || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
