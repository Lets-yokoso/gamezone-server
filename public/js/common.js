const COMMON = {
  get token() { return localStorage.getItem('gz_token'); },
  set token(v) { localStorage.setItem('gz_token', v); },
  get user() { try { return JSON.parse(localStorage.getItem('gz_user') || 'null'); } catch { return null; } },
  set user(v) { localStorage.setItem('gz_user', JSON.stringify(v)); },
  get serverUrl() { return localStorage.getItem('gz_server') || ''; },
  set serverUrl(v) { localStorage.setItem('gz_server', v); },
};

let _isRefreshing = false;

async function refreshToken() {
  if (_isRefreshing) return false;
  _isRefreshing = true;
  try {
    const res = await fetch(COMMON.serverUrl.replace(/\/$/, '') + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + COMMON.token }
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.token) {
      COMMON.token = data.token;
      localStorage.setItem('gz_user', JSON.stringify({ ...data.user, status: data.status || 'active', expiry_date: data.expiry_date || null }));
      return true;
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    _isRefreshing = false;
  }
}

async function tryAuth() {
  if (!COMMON.token || !COMMON.serverUrl) return false;
  try {
    const res = await fetch(COMMON.serverUrl.replace(/\/$/, '') + '/api/me', {
      headers: { Authorization: 'Bearer ' + COMMON.token }
    });
    if (res.status === 401) {
      const refreshed = await refreshToken();
      if (!refreshed) {
        doLogout(true);
        return false;
      }
      return true;
    }
    if (!res.ok) return false;
    const data = await res.json();
    if (data.status && COMMON.user) {
      COMMON.user.status = data.status;
      COMMON.user.expiry_date = data.expiry_date;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function requireAuth() {
  if (!COMMON.token || !COMMON.user || !COMMON.serverUrl) {
    localStorage.clear();
    window.location.href = '/';
    return false;
  }
  tryAuth();
  return true;
}

async function api(method, path, body, _retry = true) {
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
  if (!res.ok) {
    if (res.status === 401 && _retry) {
      const refreshed = await refreshToken();
      if (refreshed) return api(method, path, body, false);
    }
    throw new Error(data.error || 'Request failed');
  }
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
        if (typeof navigateTo === 'function') navigateTo('groups');
        else window.location.hash = '#/groups';
      } else if (target.type === 'history') {
        await api('DELETE', '/groups/' + target.id + '/history');
        toast('Recent activity cleared', 'ok');
      }
    } else if (state.type === 'end-session') {
      if (typeof PcControl !== 'undefined' && PcControl.endSession) PcControl.endSession();
    } else if (state.type === 'kill-all') {
      if (typeof PcControl !== 'undefined' && PcControl.killAllProcesses) PcControl.killAllProcesses();
    } else if (state.type === 'logout') {
      localStorage.clear();
      if (typeof navigateTo === 'function') navigateTo('login');
      else window.location.hash = '#/login';
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
  const sessionRate = sessionStorage.getItem('gz_hourly_rate_' + groupId);
  if (sessionRate) return parseFloat(sessionRate);
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

function doLogout(silent = false) {
  localStorage.clear();
  if (silent) {
    window.location.href = '/';
  } else {
    window._modalState = { type: 'logout' };
    showModal('Logout?', 'Are you sure you want to logout?', 'logout');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
    if (COMMON.user) {
      COMMON.user.expiry_date = expiry;
    }
  } catch {
    banner.style.display = 'none';
  }
}

function handleKeydown(e) {
  if (e.key === 'Escape') {
    const modal = document.getElementById('confirm-modal');
    if (modal && modal.classList.contains('active')) {
      closeModal();
      e.preventDefault();
      return;
    }
    const sheet = document.querySelector('.sheet.open');
    if (sheet) {
      const sheetId = sheet.id;
      closeSheet(sheetId);
      e.preventDefault();
      return;
    }
  }
  if (e.key === 'Enter') {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      if (activeEl.tagName === 'INPUT' && (activeEl.type === 'text' || activeEl.type === 'password' || activeEl.type === 'email' || activeEl.type === 'number' || activeEl.type === 'url')) {
        const form = activeEl.form;
        if (form) {
          const buttons = form.querySelectorAll('button[type="button"], .btn');
          for (let btn of buttons) {
            if (btn.getAttribute('onclick') && !btn.disabled) {
              const onclick = btn.getAttribute('onclick');
              if (onclick.includes('doLogin') || onclick.includes('doRegister') || onclick.includes('createGroup') || onclick.includes('addPC') || onclick.includes('create') || onclick.includes('save') || onclick.includes('Add') || onclick.includes('Start') || onclick.includes('Confirm')) {
                btn.click();
                e.preventDefault();
                return;
              }
            }
          }
        }
      }
    }
    const modal = document.getElementById('confirm-modal');
    if (modal && modal.classList.contains('active')) {
      const confirmBtn = document.getElementById('modal-confirm-btn');
      if (confirmBtn) confirmBtn.click();
      e.preventDefault();
      return;
    }
  }
}

document.addEventListener('keydown', handleKeydown);
