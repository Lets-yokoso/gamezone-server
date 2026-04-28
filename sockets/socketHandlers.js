const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { JWT_SECRET } = require('../config/constants');
const { _historyCache, _pendingProcs } = require('./socketCache');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(str) {
  return typeof str === 'string' && UUID_REGEX.test(str);
}

// Track last heartbeat per PC for stale connection cleanup
const _lastHeartbeat = {};

// Server-side cleanup: mark PCs offline if no heartbeat in 30 seconds
setInterval(async () => {
  const cutoff = Date.now() - 30000;
  for (const [pcId, lastSeen] of Object.entries(_lastHeartbeat)) {
    if (lastSeen < cutoff) {
      delete _lastHeartbeat[pcId];
      try {
        const pc = await db.get('pcs', p => p.id === pcId);
        if (pc && pc.is_online) {
          await db.update('pcs', p => p.id === pcId, { is_online: 0 });
          if (pc.group_id) {
            const io = global._io;
            if (io) {
              io.to(`group:${pc.group_id}`).emit(`group:${pc.group_id}:pc-status`, { pc_id: pcId, is_online: false });
            }
          }
          console.log(`[TIMEOUT] PC ${pcId} marked offline (no heartbeat)`);
        }
      } catch (e) {
        console.error(`[TIMEOUT] Error marking PC ${pcId} offline:`, e);
      }
    }
  }
}, 5000);

module.exports = (io) => {
  // Store io globally for the cleanup interval
  global._io = io;
  io.on('connection', (socket) => {

    socket.on('pc:heartbeat', async ({ pc_name, group_id, timestamp }) => {
      if (typeof pc_name !== 'string' || pc_name.length > 100) return;
      if (!isValidUUID(group_id)) return;
      if (!socket.pcId) return;
      const pc = await db.get('pcs', p => p.name === pc_name && p.group_id === group_id);
      if (!pc || pc.id !== socket.pcId) return;
      _lastHeartbeat[pc.id] = Date.now();
      if (!pc.is_online) {
        await db.update('pcs', p => p.id === pc.id, { is_online: 1 });
        io.to(`group:${group_id}`).emit(`group:${group_id}:pc-status`, { pc_id: pc.id, is_online: true });
      }
    });

    socket.on('pc:status', async ({ pc_name, group_id, is_online }) => {
      if (typeof pc_name !== 'string' || pc_name.length > 100) return;
      if (!isValidUUID(group_id)) return;
      if (typeof is_online !== 'boolean') return;
      if (!socket.pcId) return;
      console.log(`[STATUS] ${pc_name} is ${is_online ? 'online' : 'offline'}`);
      const pc = await db.get('pcs', p => p.name === pc_name && p.group_id === group_id);
      if (!pc || pc.id !== socket.pcId) return;
      io.to(`group:${group_id}`).emit(`group:${group_id}:pc-status`, {
          pc_id: pc.id,
          is_online
      });
    });

    socket.on('command:refresh-apps', ({ pc_id }) => {
      if (!isValidUUID(pc_id)) return;
      io.to(`pc:${pc_id}`).emit('command:refresh-apps', {});
      console.log(`[APP REFRESH] Requested for PC ${pc_id}`);
    });

    socket.on('pc:auth', async ({ pc_name, group_id, password }, callback) => {
      if (typeof pc_name !== 'string' || pc_name.length > 100 || !pc_name.trim())
        return callback({ success: false, error: 'Invalid PC name' });
      if (!isValidUUID(group_id))
        return callback({ success: false, error: 'Invalid group ID' });
      if (typeof password !== 'string' || password.length > 128)
        return callback({ success: false, error: 'Invalid password' });

      const pc = await db.get('pcs', p => p.name === pc_name && p.group_id === group_id);
      if (!pc || !bcrypt.compareSync(password, pc.password))
        return callback({ success: false, error: 'Invalid PC credentials' });

      const group = await db.get('groups', g => g.id === group_id);
      if (group) {
        const owner = await db.get('users', u => u.id === group.owner_id);
        if (owner) {
          let status = owner.status || 'active';
          if (status === 'active' && owner.expiry_date && Date.now() > owner.expiry_date) {
            status = 'expired';
          }
          if (status === 'deactivated' || status === 'expired') {
            return callback({ success: false, error: 'Owner account ' + status });
          }
        }
      }

      await socket.join(`pc:${pc.id}`);
      socket.pcId = pc.id;
      socket.groupId = group_id;
      _lastHeartbeat[pc.id] = Date.now();
      await db.update('pcs', p => p.id === pc.id, { is_online: 1 });
      io.to(`group:${group_id}`).emit(`group:${group_id}:pc-status`, { pc_id: pc.id, is_online: true });
      console.log(`[+] PC "${pc_name}" connected, joined room pc:${pc.id}`);
      const now = Math.floor(Date.now()/1000);
      const swStart = (pc.stopwatch_start && pc.stopwatch_start < now && (now - pc.stopwatch_start) < 86400) ? pc.stopwatch_start : 0;
      const remAuth = pc.session_end > now ? pc.session_end - now : 0;
      callback({ success: true, pc_id: pc.id, session_end: pc.session_end, stopwatch_start: swStart, remaining_seconds: remAuth });
    });

    socket.on('pc:apps', async ({ apps }) => {
      if (!socket.pcId) {
        console.warn('[APPS] Received apps before auth - ignoring');
        return;
      }
      if (!Array.isArray(apps) || apps.length > 500) return;
      await db.delete('installed_apps', a => a.pc_id === socket.pcId);
      const validApps = apps
        .filter(a => typeof a.name === 'string' && a.name.length <= 500 && typeof a.path === 'string' && a.path.length <= 1000)
        .map(a => ({ id: uuidv4(), pc_id: socket.pcId, name: a.name, path: a.path }));
      for (const a of validApps) {
        await db.insert('installed_apps', a);
      }
      console.log(`[APPS] Stored ${validApps.length} apps for PC ${socket.pcId}`);
    });

    socket.on('admin:subscribe', ({ group_id, token }) => {
      try {
        if (!isValidUUID(group_id)) return;
        jwt.verify(token, JWT_SECRET);
        socket.join(`group:${group_id}`);
        console.log(`[+] Admin subscribed to group:${group_id}`);
      } catch (e) {
        console.warn(`[!] Admin subscribe failed for group:${group_id}:`, e.message);
      }
    });

    socket.on('admin:history-update', async ({ group_id, pc_id, history }) => {
      if (!isValidUUID(group_id) || !isValidUUID(pc_id)) return;
      if (!Array.isArray(history) || history.length > 50) return;
      try {
        const filtered = history.filter(h => !h.parentId);
        await db.update('pcs', p => p.id === pc_id, { time_history: filtered });
        io.to(`group:${group_id}`).emit('admin:history-update', {
          group_id,
          pc_id,
          history: filtered
        });
      } catch(e) {}
    });

    socket.on('admin:request-history', async ({ group_id, pc_id }) => {
      if (!isValidUUID(group_id) || !isValidUUID(pc_id)) return;
      let history = [];
      try {
        const pc = await db.get('pcs', p => p.id === pc_id);
        history = (pc?.time_history || []).filter(h => !h.parentId);
      } catch(e) {}
      io.to(`group:${group_id}`).emit('admin:history-update', { group_id, pc_id, history });
    });

    socket.on('pc:processes', ({ processes, requestId }) => {
      if (!socket.pcId) return;
      if (!Array.isArray(processes)) return;
      if (_pendingProcs[socket.pcId]) {
        if (requestId && _pendingProcs[socket.pcId][requestId]) {
          const entry = _pendingProcs[socket.pcId][requestId];
          delete _pendingProcs[socket.pcId][requestId];
          if (Object.keys(_pendingProcs[socket.pcId]).length === 0) delete _pendingProcs[socket.pcId];
          entry.res.json({ processes });
        } else {
          const firstKey = Object.keys(_pendingProcs[socket.pcId])[0];
          const entry = _pendingProcs[socket.pcId][firstKey];
          delete _pendingProcs[socket.pcId][firstKey];
          if (Object.keys(_pendingProcs[socket.pcId]).length === 0) delete _pendingProcs[socket.pcId];
          entry.res.json({ processes });
        }
      }
    });

    socket.on('disconnect', async () => {
      if (socket.pcId) {
        delete _lastHeartbeat[socket.pcId];
        await db.update('pcs', p => p.id === socket.pcId, { is_online: 0 });
        if (socket.groupId) {
          io.to(`group:${socket.groupId}`).emit(`group:${socket.groupId}:pc-status`, { pc_id: socket.pcId, is_online: false });
        }
      }
    });
  });
};
