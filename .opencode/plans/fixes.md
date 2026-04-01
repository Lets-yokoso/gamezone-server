# GameZone Server — Complete Fix Plan

## Fix #1: `public/settings.html` — Infinite Recursion Crash (Line 174-179)

**Problem:** `saveGroupRate()` calls itself instead of the `common.js` utility function.

**Before:**
```js
function saveGroupRate() {
  const rate = parseFloat(document.getElementById('group-rate-input').value);
  if (!rate || rate < 0) { toast('Enter valid rate', 'err'); return; }
  saveGroupRate(window.currentGroupId, rate);  // ← CALLS ITSELF!
  toast('Rate saved', 'ok');
}
```

**After:**
```js
function handleSaveGroupRate() {
  const rate = parseFloat(document.getElementById('group-rate-input').value);
  if (!rate || rate < 0) { toast('Enter valid rate', 'err'); return; }
  saveGroupRate(window.currentGroupId, rate);
  toast('Rate saved', 'ok');
}
```

Also update the onclick handler on line 39:
```html
<!-- Before -->
<button class="btn btn-primary btn-sm" onclick="saveGroupRate()" ...>
<!-- After -->
<button class="btn btn-primary btn-sm" onclick="handleSaveGroupRate()" ...>
```

---

## Fix #2: `routes/pcs.routes.js` — Race Condition on Process Fetch (Lines 281-293)

**Problem:** Concurrent requests for the same PC overwrite each other's callbacks.

**Before:**
```js
_pendingProcs[pcId] = (processes) => {
  clearTimeout(timeout);
  delete _pendingProcs[pcId];
  res.json({ processes });
};
io.to(`pc:${pcId}`).emit('command:get-processes', {});
```

**After:**
```js
const requestId = require('crypto').randomBytes(8).toString('hex');
if (!_pendingProcs[pcId]) _pendingProcs[pcId] = {};
_pendingProcs[pcId][requestId] = { timeout, res };

const timeout = setTimeout(() => {
  if (_pendingProcs[pcId] && _pendingProcs[pcId][requestId]) {
    delete _pendingProcs[pcId][requestId];
    if (Object.keys(_pendingProcs[pcId]).length === 0) delete _pendingProcs[pcId];
    res.json({ processes: [] });
  }
}, 6000);

io.to(`pc:${pcId}`).emit('command:get-processes', { requestId });
```

Also update `sockets/socketHandlers.js` to pass `requestId` back:
```js
socket.on('pc:processes', ({ processes, requestId }) => {
  if (!socket.pcId) return;
  if (!Array.isArray(processes)) return;
  if (_pendingProcs[socket.pcId]) {
    if (requestId && _pendingProcs[socket.pcId][requestId]) {
      const entry = _pendingProcs[socket.pcId][requestId];
      clearTimeout(entry.timeout);
      delete _pendingProcs[socket.pcId][requestId];
      if (Object.keys(_pendingProcs[socket.pcId]).length === 0) delete _pendingProcs[socket.pcId];
      entry.res.json({ processes });
    } else {
      // Fallback: resolve first pending request
      const firstKey = Object.keys(_pendingProcs[socket.pcId])[0];
      const entry = _pendingProcs[socket.pcId][firstKey];
      clearTimeout(entry.timeout);
      delete _pendingProcs[socket.pcId][firstKey];
      if (Object.keys(_pendingProcs[socket.pcId]).length === 0) delete _pendingProcs[socket.pcId];
      entry.res.json({ processes });
    }
  }
});
```

---

## Fix #3: `db.js` — MongoDB Performance Anti-Pattern (Lines 44-56)

**Problem:** Every operation fetches ALL documents into memory.

**After (replace the entire `mongoWrapper` object):**
```js
const mongoWrapper = {
  all: async (t) => mongoDb.collection(t).find({}).toArray(),
  get: async (t, fn) => {
    const all = await mongoDb.collection(t).find({}).toArray();
    return all.find(fn) || null;
  },
  filter: async (t, fn) => {
    const all = await mongoDb.collection(t).find({}).toArray();
    return all.filter(fn);
  },
  insert: async (t, row) => { await mongoDb.collection(t).insertOne(row); return row; },
  insertOrIgnore: async (t, row) => {
    await mongoDb.collection(t).updateOne({ id: row.id }, { $setOnInsert: row }, { upsert: true });
    return row;
  },
  update: async (t, fn, changes) => {
    const all = await mongoDb.collection(t).find({}).toArray();
    const safe = sanitizeUpdate(changes);
    const matchIds = all.filter(fn).map(r => r.id);
    if (matchIds.length > 0) {
      await mongoDb.collection(t).updateMany(
        { id: { $in: matchIds } },
        { $set: safe }
      );
    }
  },
  delete: async (t, fn) => {
    const all = await mongoDb.collection(t).find({}).toArray();
    const matchIds = all.filter(fn).map(r => r.id);
    if (matchIds.length > 0) {
      await mongoDb.collection(t).deleteMany({ id: { $in: matchIds } });
    }
  },
};
```

---

## Fix #4: `db.js` — Local JSON Race Conditions (Lines 10-30)

**Problem:** Concurrent writes corrupt `gamezone-data.json`.

**After (wrap saveJson with a mutex queue):**
```js
let _saveQueue = Promise.resolve();

function saveJson(data) {
  _saveQueue = _saveQueue.then(() => {
    return new Promise((resolve) => {
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
      resolve();
    });
  });
  return _saveQueue;
}
```

---

## Fix #5: `public/js/common.js` + `public/settings.html` — Modal System Collision

**Problem:** Both files share `#confirm-modal` DOM but use different state variables (`_pendingAction` vs `_deleteTarget`), causing interference.

**In `common.js`, replace `executeAction()` and `confirmAction()`:**
```js
function showModal(title, message, action) {
  const titleEl = document.getElementById('modal-title');
  const msgEl = document.getElementById('modal-message');
  const confirmBtn = document.getElementById('modal-confirm-btn');
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (confirmBtn) {
    confirmBtn.className = action === 'sleep' ? 'modal-btn confirm sleep' : 'modal-btn confirm';
    confirmBtn.textContent = 'Confirm';
  }
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.add('active');
  window._modalState = { type: 'pc-action', action };
}

function closeModal() {
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.remove('active');
  window._modalState = null;
}

async function executeAction() {
  const state = window._modalState;
  if (!state) return closeModal();
  closeModal();
  try {
    if (state.type === 'pc-action') {
      await api('POST', '/pcs/' + window.currentPcId + '/' + state.action, { group_id: window.currentGroupId });
      toast(state.action.charAt(0).toUpperCase() + state.action.slice(1) + ' command sent', 'ok');
    } else if (state.type === 'delete') {
      const target = state.target;
      if (target.type === 'pc') {
        await api('DELETE', '/groups/' + window.currentGroupId + '/pcs/' + target.id);
        window.pcs = window.pcs.filter(p => p.id !== target.id);
        renderDeletePCList();
        renderReorderPCList();
        toast(target.name + ' deleted', 'ok');
      } else if (target.type === 'group') {
        await api('DELETE', '/groups/' + target.id);
        toast('Group deleted', 'ok');
        window.location.href = '/groups';
      }
    }
  } catch (e) {
    toast(e.message || 'Command failed', 'err');
  }
}

function confirmAction(action) {
  if (!window.currentPcId) { toast('No PC selected', 'err'); return; }
  const pcName = window.currentPcName || 'PC';
  if (action === 'sleep') {
    showModal('Put PC to Sleep?', `Put ${pcName} to sleep?\n\n\u26a0\ufe0f This will interrupt any active session.`, 'sleep');
  } else if (action === 'shutdown') {
    showModal('Shutdown PC?', `Shutdown ${pcName}?\n\n\u26a0\ufe0f This will end all sessions and turn off the PC.\nThis cannot be undone.`, 'shutdown');
  }
}
```

**In `settings.html`, replace `confirmDeleteGroup()`, `promptDeletePC()`, and `executeDelete()`:**
```js
function promptDeletePC(pcId, name) {
  showModal('Delete PC?', 'Delete "' + name + '"\nThis cannot be undone.', 'delete');
  document.getElementById('modal-confirm-btn').textContent = 'Delete';
  window._modalState = { type: 'delete', target: { type: 'pc', id: pcId, name } };
}

function confirmDeleteGroup() {
  showModal('Delete Group?', 'Delete "' + window.currentGroupName + '"\nAll PCs in this group will be removed.', 'delete');
  document.getElementById('modal-confirm-btn').textContent = 'Delete';
  window._modalState = { type: 'delete', target: { type: 'group', id: window.currentGroupId, name: window.currentGroupName } };
}
// Remove executeDelete() entirely — executeAction() in common.js now handles both
```

Also remove the `onclick="executeDelete()"` from the modal confirm button in `settings.html` and change it to `onclick="executeAction()"`.

---

## Fix #6: `public/groups.html` — Groups Not Persisted to sessionStorage

**Problem:** Dashboard sidebar reads `gz_groups` from sessionStorage but groups.html never writes it.

**In `groups.html`, inside `loadGroups()` after fetching groups (around line 67-69):**
```js
// Before:
const groups = await api('GET', '/groups');
window.groups = groups;
renderGroups();

// After:
const groups = await api('GET', '/groups');
window.groups = groups;
sessionStorage.setItem('gz_groups', JSON.stringify(groups));
renderGroups();
```

---

## Fix #7: `sockets/socketHandlers.js` — PC Auth Doesn't Check Owner Status

**Problem:** Expired/deactivated users' PCs can still connect.

**In the `pc:auth` handler, after finding the PC (around line 48):**
```js
// Before:
const pc = await db.get('pcs', p => p.name === pc_name && p.group_id === group_id);
if (!pc || !bcrypt.compareSync(password, pc.password))
  return callback({ success: false, error: 'Invalid PC credentials' });

// After:
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
```

---

## Fix #8: `jobs/cronScheduler.js` — 24h Interval Too Long

**Problem:** Up to 24h of unauthorized access after expiry.

**Change line 23:**
```js
// Before:
}, 86400000); // 24 hours

// After:
}, 300000); // 5 minutes
```

Also add PC session expiry checks:
```js
function initCronScheduler() {
  // User expiry check
  setInterval(async () => {
    try {
      const users = await db.filter('users', u =>
        u.status === 'active' &&
        u.expiry_date &&
        Date.now() > u.expiry_date
      );
      for (const user of users) {
        await db.update('users', u => u.id === user.id, { status: 'expired' });
        console.log(`[AUTO-EXPIRE] User ${user.username} expired`);
      }
      if (users.length > 0) {
        console.log(`[AUTO-EXPIRE] ${users.length} accounts expired`);
      }
    } catch(e) {
      console.error('[AUTO-EXPIRE] Error:', e);
    }
  }, 300000); // 5 minutes

  // PC session expiry check
  setInterval(async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const pcs = await db.filter('pcs', p =>
        (p.session_end > 0 && p.session_end < now) ||
        (p.stopwatch_start > 0 && p.stopwatch_start < now - 86400)
      );
      for (const pc of pcs) {
        await db.update('pcs', p => p.id === pc.id, { session_end: 0, stopwatch_start: 0 });
        console.log(`[AUTO-END] Session ended for PC ${pc.id}`);
      }
    } catch(e) {
      console.error('[AUTO-END] Error:', e);
    }
  }, 60000); // 1 minute
}
```

---

## Fix #9: `routes/pcs.routes.js` — App Launch Path Injection

**Problem:** `app_path` only length-validated, no content sanitization.

**Add validation to the launch route (around line 311):**
```js
// Before:
router.post('/pcs/:pcId/launch', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
  body('app_path').trim().isLength({ min: 1, max: 1000 }).withMessage('App path is required'),
  body('group_id').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {

// After:
const SAFE_PATH_REGEX = /^[a-zA-Z0-9\s\-_\.\\\/:]+$/;

router.post('/pcs/:pcId/launch', [
  param('pcId').isUUID().withMessage('Invalid PC ID'),
  body('app_path').trim().isLength({ min: 1, max: 1000 }).withMessage('App path is required')
    .matches(SAFE_PATH_REGEX).withMessage('App path contains invalid characters'),
  body('group_id').isUUID().withMessage('Invalid group ID'),
], validate, async (req, res) => {
```

---

## Fix #10: `middleware/sanitize.js` — Rename SAFE_STRING_KEYS to BLOCKED_KEYS

**Before:**
```js
const SAFE_STRING_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
]);
```

**After:**
```js
const BLOCKED_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
]);
```

Then replace all references to `SAFE_STRING_KEYS` with `BLOCKED_KEYS` in the file.

---

## Fix #11: `server.js` — Move Admin Login Rate Limiter to admin.routes.js

**In `server.js`, remove line 96:**
```js
// Delete this line:
app.use('/api/admin/login', authLimiter);
```

**In `routes/admin.routes.js`, add limiter to the login route:**
```js
const rateLimit = require('express-rate-limit');

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

router.post('/login', adminLoginLimiter, [
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
], validate, (req, res) => {
```

---

## Fix #12: `server.js` — Remove Duplicate dotenv.config()

**Delete line 1:**
```js
// Remove this line:
require('dotenv').config();
```

---

## Fix #13: `db.js` — MongoDB N+1 Updates (Already covered in Fix #3)

The `update` and `delete` methods in `mongoWrapper` now use `updateMany`/`deleteMany` with `$in` operator.

---

## Fix #14: `public/js/socket.js` — Add Disconnect/Reconnection Handling

**After:**
```js
let socket = null;
let _reconnectAttempts = 0;
const MAX_RECONNECT = 5;

function connectSocket(groupId, token, callbacks) {
  if (socket) socket.disconnect();
  _reconnectAttempts = 0;

  socket = io(COMMON.serverUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: MAX_RECONNECT,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    _reconnectAttempts = 0;
    socket.emit('admin:subscribe', { group_id: groupId, token });
    if (callbacks.onConnect) callbacks.onConnect();
  });

  socket.on('reconnect', (attempt) => {
    _reconnectAttempts = 0;
    socket.emit('admin:subscribe', { group_id: groupId, token });
    if (callbacks.onReconnect) callbacks.onReconnect(attempt);
  });

  socket.on('reconnect_error', () => {
    _reconnectAttempts++;
    if (callbacks.onReconnectError) callbacks.onReconnectError(_reconnectAttempts);
  });

  socket.on('reconnect_failed', () => {
    if (callbacks.onReconnectFailed) callbacks.onReconnectFailed();
  });

  socket.on('disconnect', (reason) => {
    if (callbacks.onDisconnect) callbacks.onDisconnect(reason);
  });

  socket.on('group:' + groupId + ':pc-status', (data) => {
    if (callbacks.onStatus) callbacks.onStatus(data);
  });

  socket.on('group:' + groupId + ':pc-session', (data) => {
    if (callbacks.onSession) callbacks.onSession(data);
  });

  socket.on('admin:history-update', (data) => {
    if (callbacks.onHistory) callbacks.onHistory(data);
  });

  return socket;
}
```

---

## Fix #15: `public/dashboard.html` — Fetch Fresh Groups for Sidebar

**Replace `renderSidebarGroups()` (around line 133):**
```js
async function renderSidebarGroups() {
  const el = document.getElementById('sidebar-groups');
  if (!el) return;
  try {
    // Try API first, fall back to sessionStorage
    let groups;
    try {
      groups = await api('GET', '/groups');
      sessionStorage.setItem('gz_groups', JSON.stringify(groups));
    } catch {
      groups = JSON.parse(sessionStorage.getItem('gz_groups') || '[]');
    }
    if (!groups.length) { el.innerHTML = '<div class="empty" style="padding:20px"><div class="empty-p">No groups</div></div>'; return; }
    el.innerHTML = groups.map(g =>
      '<div class="group-item" onclick="switchGroup(\'' + g.id + '\')" style="' + (g.id === window.currentGroupId ? 'background:var(--s2)' : '') + '">' +
      '<div class="group-item-left">' +
      '<div class="group-item-icon"><i class="fa-solid fa-network-wired"></i></div>' +
      '<div><div class="group-item-name">' + escapeHtml(g.name) + '</div></div>' +
      '</div></div>'
    ).join('');
  } catch (e) {}
}
```

---

## Fix #16: `middleware/audit.js` — Remove Unused auditStream Export

**After:**
```js
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
```

---

## Fix #17: Delete `public/exam-registration.html`

This file is a completely unrelated blog post about IGCSE exam registration. Delete it:
```
rm public/exam-registration.html
```

---

## Fix #18: `routes/groups.routes.js` — Prevent Last Admin Removal

**In the DELETE admin route (around line 88):**
```js
// Before:
router.delete('/:groupId/admins/:userId', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  param('userId').isUUID().withMessage('Invalid user ID'),
], validate, async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const group = await db.get('groups', g => g.id === groupId && g.owner_id === req.user.id);
    if (!group) return res.status(403).json({ error: 'Only owner can remove admins' });
    await db.delete('group_members', m => m.group_id === groupId && m.user_id === userId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// After:
router.delete('/:groupId/admins/:userId', [
  param('groupId').isUUID().withMessage('Invalid group ID'),
  param('userId').isUUID().withMessage('Invalid user ID'),
], validate, async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const group = await db.get('groups', g => g.id === groupId && g.owner_id === req.user.id);
    if (!group) return res.status(403).json({ error: 'Only owner can remove admins' });
    const remainingAdmins = await db.filter('group_members', m => m.group_id === groupId && m.user_id !== userId);
    if (remainingAdmins.length === 0 && req.user.id !== group.owner_id) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }
    await db.delete('group_members', m => m.group_id === groupId && m.user_id === userId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```
