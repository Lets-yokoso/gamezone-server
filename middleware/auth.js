const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET, ADMIN_SECRET } = require('../config/constants');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const p = jwt.verify(token, ADMIN_SECRET);
    if (!p.sa) throw new Error();
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

async function accountCheck(req, res, next) {
  try {
    const user = await db.get('users', u => u.id === req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    let status = user.status || 'active';
    if (status === 'active' && user.expiry_date && Date.now() > user.expiry_date) {
      status = 'expired';
      await db.update('users', u => u.id === user.id, { status: 'expired' });
    }
    if (status === 'pending') return res.status(403).json({ error: 'account_pending' });
    if (status === 'deactivated') return res.status(403).json({ error: 'account_deactivated' });
    if (status === 'expired') return res.status(403).json({ error: 'subscription_expired' });
    next();
  } catch (e) {
    console.error('[accountCheck] Error:', e);
    res.status(500).json({ error: 'Account verification failed' });
  }
}

module.exports = {
  authMiddleware,
  adminAuth,
  accountCheck
};
