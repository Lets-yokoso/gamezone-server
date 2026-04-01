const morgan = require('morgan');

function auditLogger(req, res, next) {
  const start = Date.now();
  const originalEnd = res.end;

  res.end = function (...args) {
    originalEnd.apply(res, args);
    const duration = Date.now() - start;
    const log = `[AUDIT] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms user=${req.user?.id || 'unauthenticated'}`;
    if (res.statusCode >= 400) {
      console.warn(log);
    } else {
      console.log(log);
    }
  };

  next();
}

module.exports = { auditLogger };
