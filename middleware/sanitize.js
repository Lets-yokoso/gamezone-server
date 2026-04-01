const BLOCKED_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
]);

function sanitizeObject(obj, depth = 0) {
  if (depth > 5) return null;
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number') {
    if (isNaN(obj) || !isFinite(obj)) return 0;
    return obj;
  }
  if (typeof obj === 'boolean') return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item, depth + 1));
  if (typeof obj !== 'object') return obj;

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (BLOCKED_KEYS.has(key)) continue;
    clean[key] = sanitizeObject(value, depth + 1);
  }
  return clean;
}

function sanitizeUpdate(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (BLOCKED_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      clean[key] = value;
    } else if (typeof value === 'number') {
      clean[key] = isNaN(value) || !isFinite(value) ? 0 : value;
    } else if (typeof value === 'boolean') {
      clean[key] = value;
    } else if (value === null) {
      clean[key] = null;
    } else if (Array.isArray(value)) {
      clean[key] = value.map(item => sanitizeObject(item));
    }
  }
  return clean;
}

module.exports = { sanitizeObject, sanitizeUpdate };
