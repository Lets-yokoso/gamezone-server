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

module.exports = (io) => {
  io.on('connection', (socket) => {

    socket.on('pc:heartbeat', async ({ pc_name, group_id, timestamp }) => {
      if (typeof pc_name !== 'string' || pc_name.length > 100) return;
      if (!isValidUUID(group_id)) return;
      if (!socket.pcId) return;
      const pc = await db.get('pcs', p => p.name === pc_name && p.group_id === group_id);
      if (!pc || pc.id !== socket.pcId) return;
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

      socket.join(`pc:${pc.id}`);
      socket.pcId = pc.id;
      socket.groupId = group_id;
      await db.update('pcs', p => p.id === pc.id, { is_online: 1 });
      io.to(`group:${group_id}`).emit(`group:${group_id}:pc-status`, { pc_id: pc.id, is_online: true });
      console.log(`[+] PC "${pc_name}" connected`);
      const now = Math.floor(Date.now()/1000);
      const swStart = (pc.stopwatch_start && pc.stopwatch_start < now && (now - pc.stopwatch_start) < 86400) ? pc.stopwatch_start : 0;
      const remAuth = pc.session_end > now ? pc.session_end - now : 0;
      callback({ success: true, pc_id: pc.id, session_end: pc.session_end, stopwatch_start: swStart, remaining_seconds: remAuth });
    });

    socket.on('pc:apps', async ({ apps }) => {
      if (!socket.pcId) return;
      if (!Array.isArray(apps) || apps.length > 500) return;
      await db.delete('installed_apps', a => a.pc_id === socket.pcId);
      const validApps = apps
        .filter(a => typeof a.name === 'string' && a.name.length <= 200 && typeof a.path === 'string' && a.path.length <= 1000)
        .map(a => ({ id: uuidv4(), pc_id: socket.pcId, name: a.name, path: a.path }));
      for (const a of validApps) {
        await db.insert('installed_apps', a);
      }
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
      _historyCache[pc_id] = history;
      io.to(`group:${group_id}`).emit('admin:history-update', {
        group_id,
        pc_id,
        history
      });
    });

    socket.on('admin:request-history', async ({ group_id, pc_id }) => {
      if (!isValidUUID(group_id) || !isValidUUID(pc_id)) return;
      if (_historyCache[pc_id]) {
        io.to(`group:${group_id}`).emit('admin:history-update', { group_id, pc_id, history: _historyCache[pc_id] });
      } else {
        const pc = await db.get('pcs', p => p.id === pc_id);
        if (pc) {
          _historyCache[pc_id] = pc.time_history || [];
          io.to(`group:${group_id}`).emit('admin:history-update', { group_id, pc_id, history: pc.time_history || [] });
        }
      }
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
        await db.update('pcs', p => p.id === socket.pcId, { is_online: 0 });
        if (socket.groupId) {
          io.to(`group:${socket.groupId}`).emit(`group:${socket.groupId}:pc-status`, { pc_id: socket.pcId, is_online: false });
        }
      }
    });
  });
};
