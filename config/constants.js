require('dotenv').config();
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

const ADMIN_UNAME = process.env.ADMIN_USERNAME;
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!ADMIN_UNAME || !ADMIN_HASH) {
  console.error('FATAL: ADMIN_USERNAME and ADMIN_PASSWORD_HASH environment variables are required');
  process.exit(1);
}

const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!ADMIN_SECRET) {
  console.error('FATAL: ADMIN_SECRET environment variable is required');
  process.exit(1);
}

const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

const NODE_ENV = process.env.NODE_ENV || 'development';

module.exports = {
  JWT_SECRET,
  PORT,
  ADMIN_UNAME,
  ADMIN_HASH,
  ADMIN_SECRET,
  CORS_ORIGINS,
  NODE_ENV,
};
