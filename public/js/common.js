const COMMON = {
  get token() { return localStorage.getItem('gz_token'); },
  set token(v) { localStorage.setItem('gz_token', v); },
  get user() { try { return JSON.parse(localStorage.getItem('gz_user') || 'null'); } catch { return null; } },
  set user(v) { localStorage.setItem('gz_user', JSON.stringify(v)); },
  get serverUrl() { return localStorage.getItem('gz_server') || ''; },
  set serverUrl(v) { localStorage.setItem('gz_server', v); },
};

function requireAuth() {
  if (!COMMON.token || !COMMON.user || !COMMON.serverUrl) {
    localStorage.clear();
    window.location.href = '/';
    return false;
  }
  return true;
}

async function api(method, path, body) {
  const base = COMMON.serverUrl.replace(/\/$/, '');
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COMMON.token ? { Authorization: 'Bearer ' + COMMON.token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = res.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(res.status >= 500 ? `Server error (${res.status})` : text || `Request failed (${res.status})`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function fmtTime(secs) {
  if (secs <= 0) return '00:00';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function openSheet(id) {
  const sheet = document.getElementById(id);
  const bg = document.getElementById('bg-' + id.replace('sheet-', ''));
  if (sheet) sheet.classList.add('open');
  if (bg) bg.classList.add('open');
}

function closeSheet(id) {
  const sheet = document.getElementById(id);
  const bg = document.getElementById('bg-' + id.replace('sheet-', ''));
  if (sheet) sheet.classList.remove('open');
  if (bg) bg.classList.remove('open');
}

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
  if (!window._modalState) {
    window._modalState = { type: 'pc-action', action };
  }
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
        if (window.pcs) window.pcs = window.pcs.filter(p => p.id !== target.id);
        if (typeof renderDeletePCList === 'function') renderDeletePCList();
        if (typeof renderReorderPCList === 'function') renderReorderPCList();
        toast(target.name + ' deleted', 'ok');
      } else if (target.type === 'group') {
        await api('DELETE', '/groups/' + target.id);
        toast('Group deleted', 'ok');
        window.location.href = '/groups';
      }
    } else if (state.type === 'end-session') {
      if (typeof confirmEndSessionAction === 'function') confirmEndSessionAction();
    } else if (state.type === 'kill-all') {
      if (typeof killAllProcesses === 'function') killAllProcesses();
    } else if (state.type === 'logout') {
      localStorage.clear();
      window.location.href = '/';
    } else if (state.type === 'remove-admin') {
      if (typeof removeAdminAction === 'function') removeAdminAction(state.adminId, state.adminName);
    }
  } catch (e) {
    toast(e.message || 'Command failed', 'err');
  }
}

function confirmAction(action) {
  if (!window.currentPcId) { toast('No PC selected', 'err'); return; }
  window._modalState = { type: 'pc-action', action };
  const pcName = window.currentPcName || 'PC';
  if (action === 'sleep') {
    showModal('Put PC to Sleep?', `Put ${pcName} to sleep?\n\n\u26a0\ufe0f This will interrupt any active session.`, 'sleep');
  } else if (action === 'shutdown') {
    showModal('Shutdown PC?', `Shutdown ${pcName}?\n\n\u26a0\ufe0f This will end all sessions and turn off the PC.\nThis cannot be undone.`, 'shutdown');
  }
}

function getPrefs() {
  try { return JSON.parse(localStorage.getItem('gz_prefs') || '{}'); } catch { return {}; }
}

function togglePref(key) {
  const prefs = getPrefs();
  prefs[key] = !prefs[key];
  localStorage.setItem('gz_prefs', JSON.stringify(prefs));
  applyPrefs();
}

function applyPrefs() {
  const prefs = getPrefs();
  const addGroupFab = document.querySelector('.fab[data-action="newgroup"]');
  const addPcFab = document.querySelector('.fab[data-action="addpc"]');
  if (addGroupFab) addGroupFab.style.display = prefs.hideAddGroup ? 'none' : '';
  if (addPcFab) addPcFab.style.display = prefs.hideAddPC ? 'none' : '';
  ['hideAddGroup', 'hideAddPC'].forEach(key => {
    const el = document.getElementById('pref-' + key);
    if (!el) return;
    const on = !!prefs[key];
    el.style.background = on ? 'var(--green)' : 'var(--s4)';
    const dot = el.querySelector('div');
    if (dot) dot.style.transform = on ? 'translateX(16px)' : 'translateX(0)';
  });
}

function getGroupRate(groupId) {
  if (!groupId) return 5;
  try {
    const rates = JSON.parse(localStorage.getItem('gz_group_rates') || '{}');
    return rates[groupId] || 5;
  } catch { return 5; }
}

function saveGroupRate(groupId, rate) {
  try {
    const rates = JSON.parse(localStorage.getItem('gz_group_rates') || '{}');
    rates[groupId] = rate;
    localStorage.setItem('gz_group_rates', JSON.stringify(rates));
  } catch (e) { toast('Failed to save', 'err'); }
}

const _LH_KEY = 'gz_history_';
function lhGet(pcId) { try { return JSON.parse(localStorage.getItem(_LH_KEY + pcId) || '[]'); } catch { return []; } }
function lhSet(pcId, entries, socket, groupId) {
  localStorage.setItem(_LH_KEY + pcId, JSON.stringify(entries.slice(0, 5)));
  if (socket && socket.connected && groupId) {
    socket.emit('admin:history-update', { group_id: groupId, pc_id: pcId, history: entries.slice(0, 5) });
  }
}
function lhAdd(pcId, entry, socket, groupId) {
  const h = lhGet(pcId);
  h.unshift(entry);
  lhSet(pcId, h, socket, groupId);
}

function doLogout() {
  showModal('Logout?', 'Are you sure you want to logout?', 'logout');
}

async function checkExpiryWarning() {
  const banner = document.getElementById('expiry-banner');
  if (!banner) return;
  try {
    const data = await api('GET', '/me');
    const expiry = data.expiry_date;
    if (!expiry) { banner.style.display = 'none'; return; }
    const daysLeft = Math.ceil((expiry - Date.now()) / 86400000);
    if (daysLeft > 0 && daysLeft <= 5) {
      banner.style.display = 'flex';
      const daysEl = document.getElementById('expiry-days');
      if (daysEl) daysEl.textContent = daysLeft;
    } else {
      banner.style.display = 'none';
    }
    // Update localStorage with fresh user data
    if (COMMON.user) {
      COMMON.user.expiry_date = expiry;
    }
  } catch {
    banner.style.display = 'none';
  }
}
