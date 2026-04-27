const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');
const hpp = require('hpp');
const morgan = require('morgan');
const path = require('path');
const db = require('./db');
const { PORT, CORS_ORIGINS, NODE_ENV } = require('./config/constants');
const { initCronScheduler } = require('./jobs/cronScheduler');

const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const groupsRoutes = require('./routes/groups.routes');
const pcsRoutes = require('./routes/pcs.routes');
const setupSocketHandlers = require('./sockets/socketHandlers');
const { auditLogger } = require('./middleware/audit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'] },
});

app.set('io', io);

// ── Security Middleware ────────────────────────────────────────────────────────

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
  maxAge: 86400,
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

app.use(xss());
app.use(hpp());

if (NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

app.use('/api', auditLogger);

// ── Rate Limiting ──────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api', globalLimiter);

// ── Page Routes (Multi-Page) ──────────────────────────────────────────────────

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/app/:view', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/settings', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

// Admin portal fallback
app.get('/connect', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── Static Files ───────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ─────────────────────────────────────────────────────────────────

app.use('/api', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api', pcsRoutes);

// ── Health Check ───────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    await db._ready;
    res.json({ status: 'ok', database: 'connected', uptime: process.uptime() });
  } catch {
    res.json({ status: 'ok', database: 'disconnected', uptime: process.uptime() });
  }
});

// ── 404 Handler ────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global Error Handler ───────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[UNHANDLED ERROR]', err);
  res.status(err.status || 500).json({
    error: NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Socket.IO ──────────────────────────────────────────────────────────────────

setupSocketHandlers(io);

// ── Start Server ───────────────────────────────────────────────────────────────

db._ready.then(() => {
  server.listen(PORT, () => {
    console.log(`\nGameZone Server running on port ${PORT}`);
    console.log(`   Mode: ${process.env.MONGODB_URI ? 'MongoDB (cloud)' : 'Local JSON file'}`);
    console.log(`   Environment: ${NODE_ENV}`);
    console.log(`   Pages: / /groups /dashboard /pc-control /settings`);
    console.log(`   Admin panel: /connect\n`);
    initCronScheduler();
  });
}).catch(err => {
  console.error('Failed to connect to database:', err);
  process.exit(1);
});
