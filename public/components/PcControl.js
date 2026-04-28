(function() {
  const PcControl = window.PcControl = {};
  let _socket = null;
  let _timerInterval = null;

  function updateOnlinePill() {
    const pc = window.pc;
    if (!pc) return;
    const pill = document.getElementById('pc-pill');
    if (!pill) return;
    if (pc.is_online) {
      pill.innerHTML = '<span class="dot" style="background:var(--green)"></span> Online';
      pill.style.cssText = 'color:var(--green);border-color:var(--green-bd);background:var(--green-bg)';
    } else {
      pill.innerHTML = '<span class="dot" style="background:var(--t3)"></span> Offline';
      pill.style.cssText = '';
    }
  }

  PcControl.renderActions = function() {
    const pc = window.pc;
    if (!pc) return;
    const now = Math.floor(Date.now() / 1000);
    const left = pc.session_end > now ? pc.session_end - now : 0;
    const isWatch = pc.stopwatch_start > 0;
    const isActive = left > 0 || isWatch;
    const pay = pc.payment_status || null;
    const timerArea = document.getElementById('pc-timer-area');
    if (!timerArea) return;
    const col = isActive ? (isWatch ? 'var(--blue)' : left <= 30 ? 'var(--red)' : left <= 60 ? 'var(--amber)' : 'var(--green)') : 'var(--t3)';
    const val = isActive ? (isWatch ? fmtTime(now - pc.stopwatch_start) : fmtTime(left)) : '--:--';
    timerArea.innerHTML = '<div class="timer-card">' +
      '<div class="timer-big" style="color:' + col + '">' + val + '</div>' +
      '<div class="pay-col">' +
      '<button class="pay-btn ' + (pay === 'paid' ? 'paid' : '') + '" onclick="PcControl.togglePay(\'paid\')"><i class="fa-solid fa-check"></i> Paid</button>' +
      '<button class="pay-btn ' + (pay === 'unpaid' ? 'unpaid' : '') + '" onclick="PcControl.togglePay(\'unpaid\')"><i class="fa-solid fa-xmark"></i> Unpaid</button>' +
      '</div></div>';
    const sessionArea = document.getElementById('pc-session-area');
    if (!sessionArea) return;
    let html = '';
    if (isActive) {
      html += '<div class="section-head">Session Control</div>' +
        '<div class="action-grid cols3" style="margin-bottom:20px">' +
        '<div class="action-card" onclick="openSheet(\'sheet-addtime\')"><div class="action-card-icon"><i class="fa-solid fa-circle-plus" style="color:var(--green)"></i></div><div class="action-card-label">Add Time</div></div>' +
        '<div class="action-card" onclick="openSheet(\'sheet-removetime\')"><div class="action-card-icon"><i class="fa-solid fa-circle-minus" style="color:var(--amber)"></i></div><div class="action-card-label">Remove</div></div>' +
        '<div class="action-card" onclick="PcControl.confirmEndSession()"><div class="action-card-icon"><i class="fa-solid fa-stop" style="color:var(--red)"></i></div><div class="action-card-label">End</div></div>' +
        '</div>';
    } else {
      html += '<div class="section-head">Session Control</div>' +
        '<div class="action-grid cols1" style="margin-bottom:20px">' +
        '<div class="action-card" onclick="openSheet(\'sheet-startsession\')">' +
        '<div class="action-card-icon"><i class="fa-solid fa-play" style="color:var(--green)"></i></div>' +
        '<div class="action-card-label">Start Session</div>' +
        '<div class="action-card-sub">Timed or free timer</div>' +
        '</div></div>';
    }
    const history = _cachedHistory;
    html += '<div class="section-head" style="justify-content:space-between;margin-top:20px">Recent Activity ' +
      '<button onclick="PcControl.refreshHistory()" style="margin-left:auto;background:var(--s3);border:1px solid var(--bd2);color:var(--t2);cursor:pointer;font-size:10px;font-family:var(--sans);display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:var(--r);letter-spacing:0;text-transform:none;font-weight:600;transition:all .15s" onmouseover="this.style.color=\'var(--t1)\'" onmouseout="this.style.color=\'var(--t2)\'"><i class="fa-solid fa-rotate" style="font-size:10px"></i> Refresh</button></div>' +
      '<div class="action-grid" style="padding-bottom:0;margin-bottom:20px;display:block">' +
      '<div style="background:var(--s1);border:1px solid var(--bd);border-radius:var(--r2);overflow:hidden">';
    if (history && history.length > 0) {
      history.forEach(entry => {
        const isSession = entry.type === 'session';
        const isFree = isSession && entry.mode === 'free';
        const isEnded = entry.status === 'ended';
        let valStr, label, icon;
        if (isSession) {
          if (isFree) { icon = '⏱'; label = isEnded ? 'Free Session (ended)' : 'Free Session'; valStr = isEnded && entry.mins ? entry.mins + 'm' : 'FREE'; }
          else { icon = '⏰'; label = isEnded ? 'Session (ended)' : 'Session'; valStr = (entry.mins || 0) + 'm'; }
        } else {
          const isAdd = entry.type === 'add';
          icon = isAdd ? '+' : '-';
          valStr = (isAdd ? '+' : '-') + Math.abs(entry.mins) + 'm';
          label = isAdd ? 'Added' : 'Removed';
        }
        const col2 = isFree ? 'var(--blue)' : 'var(--green)';
        html += '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--bd)">' +
          '<span style="font-size:13px;font-weight:700;color:' + col2 + ';font-family:var(--mono)">' + icon + ' ' + escapeHtml(valStr) + '</span>' +
          '<span style="font-size:11px;color:var(--t3)">' + escapeHtml(label) + '</span>' +
          (isEnded ? '<span style="font-size:9px;color:var(--t3);margin-left:auto">(ended)</span>' : '') +
          '</div>';
      });
    } else {
      html += '<div style="text-align:center;padding:20px;color:var(--t3);font-size:12px">No recent activity</div>';
    }
    html += '</div></div>';
    sessionArea.innerHTML = html;
  };

  function updateTimer() {
    const pc = window.pc;
    if (!pc) return;
    const now = Math.floor(Date.now() / 1000);
    const left = pc.session_end > now ? pc.session_end - now : 0;
    const isWatch = pc.stopwatch_start > 0;
    const elapsed = isWatch ? now - pc.stopwatch_start : 0;
    const timerBig = document.querySelector('.timer-big');
    if (timerBig) timerBig.textContent = isWatch ? fmtTime(elapsed) : (left > 0 ? fmtTime(left) : '--:--');
  }

  PcControl.togglePay = async function(status) {
    const id = window.currentPcId;
    const newStatus = window.pc.payment_status === status ? null : status;
    try {
      await api('POST', '/pcs/' + id + '/payment', { payment_status: newStatus, group_id: window.currentGroupId });
      window.pc.payment_status = newStatus;
      PcControl.renderActions();
      toast(newStatus ? 'Marked ' + newStatus : 'Payment cleared', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.startSession = async function(mins) {
    closeSheet('sheet-startsession');
    try {
      const r = await api('POST', '/pcs/' + window.currentPcId + '/session/start', { duration_minutes: mins, group_id: window.currentGroupId });
      window.pc.session_end = r.session_end;
      window.pc.stopwatch_start = 0;
      toast('Session started', 'ok');
      PcControl.renderActions();
      setTimeout(() => PcControl.refreshHistory(), 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.startStopwatch = async function() {
    closeSheet('sheet-startsession');
    try {
      const r = await api('POST', '/pcs/' + window.currentPcId + '/session/stopwatch', { group_id: window.currentGroupId });
      window.pc.stopwatch_start = r.started_at;
      window.pc.session_end = 0;
      toast('Free timer started', 'ok');
      PcControl.renderActions();
      setTimeout(() => PcControl.refreshHistory(), 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.startSessionByAmount = async function() {
    const amount = parseFloat(document.getElementById('session-amount').value);
    const mins = parseInt(document.getElementById('session-mins').value) || 0;
    if (!amount && !mins) { toast('Enter amount or minutes', 'err'); return; }
    closeSheet('sheet-startsession');
    let totalMins = mins;
    if (amount && amount > 0) {
      const rate = getGroupRate(window.currentGroupId);
      totalMins += Math.floor((amount / rate) * 60);
    }
    if (totalMins < 1) { toast('Duration too low', 'err'); return; }
    try {
      const r = await api('POST', '/pcs/' + window.currentPcId + '/session/start', { duration_minutes: totalMins, group_id: window.currentGroupId });
      window.pc.session_end = r.session_end;
      window.pc.stopwatch_start = 0;
      document.getElementById('session-amount').value = '';
      document.getElementById('session-mins').value = '';
      toast('Session started: ' + totalMins + 'm', 'ok');
      PcControl.renderActions();
      setTimeout(() => PcControl.refreshHistory(), 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.addTime = async function(mins) {
    closeSheet('sheet-addtime');
    try {
      const r = await api('POST', '/pcs/' + window.currentPcId + '/session/add-time', { minutes: mins, group_id: window.currentGroupId });
      if (r.stopwatch_start !== undefined) { window.pc.stopwatch_start = r.stopwatch_start; } else { window.pc.session_end = r.session_end; }
      toast('+' + mins + 'm added', 'ok');
      PcControl.renderActions();
      setTimeout(() => PcControl.refreshHistory(), 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.addTimeByAmount = async function() {
    const amount = parseFloat(document.getElementById('add-amount').value);
    const mins = parseInt(document.getElementById('add-mins').value) || 0;
    if (!amount && !mins) { toast('Enter amount or minutes', 'err'); return; }
    closeSheet('sheet-addtime');
    if (amount && amount > 0) {
      const rate = getGroupRate(window.currentGroupId);
      const calcMins = Math.floor((amount / rate) * 60);
      if (calcMins < 1) { toast('Amount too low', 'err'); return; }
      const r = await api('POST', '/pcs/' + window.currentPcId + '/session/add-time', { minutes: calcMins, group_id: window.currentGroupId });
      if (r.stopwatch_start !== undefined) { window.pc.stopwatch_start = r.stopwatch_start; } else { window.pc.session_end = r.session_end; }
      toast('Added: $' + amount.toFixed(2) + ' = ' + calcMins + 'm', 'ok');
    } else if (mins && mins > 0) {
      const r = await api('POST', '/pcs/' + window.currentPcId + '/session/add-time', { minutes: mins, group_id: window.currentGroupId });
      if (r.stopwatch_start !== undefined) { window.pc.stopwatch_start = r.stopwatch_start; } else { window.pc.session_end = r.session_end; }
      toast('Added: ' + mins + 'm', 'ok');
    }
    document.getElementById('add-amount').value = '';
    document.getElementById('add-mins').value = '';
    PcControl.renderActions();
    setTimeout(() => PcControl.refreshHistory(), 500);
  };

  PcControl.removeTime = async function(mins) {
    closeSheet('sheet-removetime');
    try {
      const r = await api('POST', '/pcs/' + window.currentPcId + '/session/add-time', { minutes: -mins, group_id: window.currentGroupId });
      if (r.session_ended) {
        window.pc.session_end = 0;
        window.pc.stopwatch_start = 0;
        toast('Session ended — time exceeded', 'ok');
      } else {
        window.pc.session_end = r.session_end;
        toast('-' + mins + 'm removed', 'ok');
      }
      PcControl.renderActions();
      setTimeout(() => PcControl.refreshHistory(), 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.confirmEndSession = function() {
    showModal('End Session?', 'End session on ' + escapeHtml(window.pc.name) + '?\n\n⚠️ Screen will lock immediately.', 'end-session');
    document.getElementById('modal-confirm-btn').textContent = 'End Session';
    window._modalState = { type: 'end-session' };
  };

  PcControl.endSession = async function() {
    try {
      await api('POST', '/pcs/' + window.currentPcId + '/session/end', { group_id: window.currentGroupId });
      window.pc.session_end = 0;
      window.pc.stopwatch_start = 0;
      toast('Session ended', 'ok');
      PcControl.renderActions();
      setTimeout(() => PcControl.refreshHistory(), 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.pcCmd = async function(action) {
    try {
      await api('POST', '/pcs/' + window.currentPcId + '/' + action, { group_id: window.currentGroupId });
      toast(action === 'lock' ? 'Screen locked' : 'Screen unlocked', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  PcControl.openApps = async function() {
    const pcNameEl = document.getElementById('apps-pc-name');
    const listEl = document.getElementById('apps-list');
    if (pcNameEl) pcNameEl.textContent = 'on ' + window.pc.name;
    if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:28px"><span class="spin"></span></div>';
    openSheet('sheet-apps');
    try {
      const apps = await api('GET', '/pcs/' + window.currentPcId + '/apps');
      window._apps = apps;
      if (!apps.length) { if (listEl) listEl.innerHTML = '<div style="color:var(--t2);text-align:center;padding:28px;font-size:12px">No shortcuts found.<br>Add .lnk files to the shortcuts folder.</div>'; return; }
      if (listEl) listEl.innerHTML = apps.map((a, i) => '<div class="app-row"><div class="app-name"><i class="fa-solid fa-file"></i>' + escapeHtml(a.name) + '</div><button class="launch-btn" onclick="PcControl.launchApp(' + i + ')"><i class="fa-solid fa-play"></i> Launch</button></div>').join('');
    } catch { if (listEl) listEl.innerHTML = '<div style="color:var(--red);text-align:center;padding:20px">Failed to load apps</div>'; }
  };

  PcControl.openKillSheet = async function() {
    const pcNameEl = document.getElementById('killtasks-pc-name');
    const listEl = document.getElementById('killtasks-list');
    if (pcNameEl) pcNameEl.textContent = 'on ' + window.pc.name;
    if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:28px"><span class="spin"></span><div style="color:var(--t3);font-size:11px;margin-top:10px">Fetching running processes...</div></div>';
    openSheet('sheet-killtasks');
    try {
      const r = await api('POST', '/pcs/' + window.currentPcId + '/processes', { group_id: window.currentGroupId });
      window._procs = r.processes || [];
      if (!window._procs.length) { if (listEl) listEl.innerHTML = '<div style="color:var(--t2);text-align:center;padding:28px;font-size:12px">No user processes found<br>or PC client is offline</div>'; return; }
      if (listEl) listEl.innerHTML = window._procs.map((p, i) =>
        '<div class="app-row"><div class="app-name"><i class="fa-solid fa-microchip" style="color:var(--t3)"></i><div><div style="font-size:13px;font-weight:600">' + escapeHtml(p.display) + '</div><div style="font-size:10px;color:var(--t3)">' + escapeHtml(String(p.mem)) + ' MB</div></div></div>' +
        '<button class="launch-btn" style="background:var(--red-bg);border-color:var(--red-bd);color:var(--red)" onclick="PcControl.killProcess(' + i + ')"><i class="fa-solid fa-xmark"></i> Kill</button></div>'
      ).join('');
    } catch { if (listEl) listEl.innerHTML = '<div style="color:var(--red);text-align:center;padding:20px">Failed to fetch processes</div>'; }
  };

  PcControl.killAllProcesses = async function() {
    const procs = window._procs.slice();
    const results = await Promise.allSettled(procs.map(proc => api('POST', '/pcs/' + window.currentPcId + '/kill-process', { pid: proc.pid, name: proc.name, group_id: window.currentGroupId })));
    window._procs = [];
    const failed = results.filter(r => r.status === 'rejected').length;
    const listEl = document.getElementById('killtasks-list');
    if (listEl) listEl.innerHTML = '<div style="color:var(--green);text-align:center;padding:28px;font-size:12px">All processes killed' + (failed ? ' (' + failed + ' failed)' : '') + '</div>';
    toast('All processes killed' + (failed ? ' (' + failed + ' failed)' : ''), 'ok');
  };

  PcControl.killProcess = async function(i) {
    const proc = window._procs?.[i];
    if (!proc) return;
    try {
      await api('POST', '/pcs/' + window.currentPcId + '/kill-process', { pid: proc.pid, name: proc.name, group_id: window.currentGroupId });
      window._procs.splice(i, 1);
      toast(proc.display + ' killed', 'ok');
      if (!window._procs.length) closeSheet('sheet-killtasks');
      else PcControl.openKillSheet();
    } catch { toast(e.message, 'err'); }
  };

  PcControl.launchApp = async function(i) {
    const app = window._apps?.[i];
    if (!app) return;
    closeSheet('sheet-apps');
    try { await api('POST', '/pcs/' + window.currentPcId + '/launch', { app_path: app.path, group_id: window.currentGroupId }); toast(app.name + ' launched', 'ok'); }
    catch { toast(e.message, 'err'); }
  };

  PcControl.refreshHistory = async function() {
    try {
      const r = await api('GET', '/pcs/' + window.currentPcId + '/history');
      _cachedHistory = r.history || [];
      PcControl.renderActions();
    } catch (e) { toast(e.message, 'err'); }
  };

  let _cachedHistory = [];

  function handleStatusUpdate(data) {
    if (data.pc_id === window.currentPcId) {
      window.pc.is_online = data.is_online ? 1 : 0;
      updateOnlinePill();
    }
  }

  function handleSessionUpdate(data) {
    if (data.pc_id !== window.currentPcId) return;
    const wasActive = window.pc.session_end > 0 || window.pc.stopwatch_start > 0;
    if ('session_end' in data) window.pc.session_end = data.session_end;
    if ('stopwatch_start' in data) window.pc.stopwatch_start = data.stopwatch_start;
    if ('payment_status' in data) window.pc.payment_status = data.payment_status;
    PcControl.renderActions();
    updateOnlinePill();
    const isEnded = data.session_end === 0 && data.stopwatch_start === 0;
    if (wasActive && isEnded) {
      setTimeout(() => PcControl.refreshHistory(), 500);
    }
  }

  function handleHistoryUpdate(data) {
    if (data.pc_id === window.currentPcId) {
      _cachedHistory = data.history || [];
      PcControl.refreshHistory();
    }
  }

  PcControl.renderSidebarGroups = function() {
    const el = document.getElementById('sidebar-groups');
    if (!el) return;
    try {
      const groups = JSON.parse(sessionStorage.getItem('gz_groups') || '[]');
      if (!groups.length) { el.innerHTML = '<div class="empty" style="padding:20px"><div class="empty-p">No groups</div></div>'; return; }
      el.innerHTML = groups.map(g =>
        '<div class="group-item" data-group-id="' + g.id + '" style="' + (g.id === window.currentGroupId ? 'background:var(--s2)' : '') + '">' +
        '<div class="group-item-left">' +
        '<div class="group-item-icon"><i class="fa-solid fa-network-wired"></i></div>' +
        '<div><div class="group-item-name">' + escapeHtml(g.name) + '</div></div>' +
        '</div></div>'
      ).join('');
    } catch {}
  };

  PcControl.connectSocket = function() {
    if (_socket) _socket.disconnect();
    _socket = io(COMMON.serverUrl, { transports: ['websocket'], reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
    _socket.on('connect', () => { _socket.emit('admin:subscribe', { group_id: window.currentGroupId, token: COMMON.token }); });
    _socket.on('group:' + window.currentGroupId + ':pc-status', handleStatusUpdate);
    _socket.on('group:' + window.currentGroupId + ':pc-session', handleSessionUpdate);
    _socket.on('admin:history-update', handleHistoryUpdate);
  };

  PcControl.disconnectSocket = function() {
    if (_socket) { _socket.disconnect(); _socket = null; }
  };

  PcControl.start = function() {
    const pc = JSON.parse(sessionStorage.getItem('gz_activePc') || 'null');
    const groupId = sessionStorage.getItem('gz_activeGroupId');
    if (!pc || !groupId) { navigateTo('dashboard'); return; }
    window.currentPcId = pc.id;
    window.currentPcName = pc.name;
    window.currentGroupId = groupId;
    window.pc = pc;
    document.getElementById('app').innerHTML = PcControl.render(pc.name);
    setTimeout(async () => {
      try {
        const r = await api('GET', '/pcs/' + pc.id + '/history');
        _cachedHistory = r.history || [];
      } catch {}
      PcControl.renderSidebarGroups();
      const sidebar = document.getElementById('sidebar-groups');
      if (sidebar) {
        sidebar.addEventListener('click', e => {
          const item = e.target.closest('.group-item');
          if (item) window.switchGroup(item.dataset.groupId);
        });
      }
      updateOnlinePill();
      PcControl.renderActions();
      PcControl.refreshHistory();
      PcControl.connectSocket();
      _timerInterval = setInterval(updateTimer, 1000);
    }, 0);
    return true;
  };

  PcControl.cleanup = function() {
    PcControl.disconnectSocket();
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  };

  PcControl.render = function(pcName) {
    return '<div id="app" class="app-layout">' +
      '<div class="sidebar-col">' +
        '<div class="sidebar-header">' +
          '<div class="sidebar-brand"><div class="sidebar-brand-icon"><i class="fa-solid fa-gamepad"></i></div>GameZone</div>' +
          '<div class="sidebar-actions"><button class="icon-btn" onclick="doLogout()" title="Logout"><i class="fa-solid fa-right-from-bracket"></i></button></div>' +
        '</div>' +
        '<div class="topbar"><div class="topbar-title">Groups</div><button class="icon-btn" onclick="doLogout()"><i class="fa-solid fa-right-from-bracket"></i></button></div>' +
        '<div class="scroll-area"><div class="screen-pad" id="sidebar-groups"></div></div>' +
      '</div>' +
      '<div class="main-col">' +
        '<div class="topbar">' +
          '<button class="back-btn" onclick="navigateTo(\'dashboard\')"><i class="fa-solid fa-chevron-left"></i></button>' +
          '<div class="topbar-title" id="pc-title">' + escapeHtml(pcName) + '</div>' +
          '<div id="pc-pill" class="status-pill"></div>' +
        '</div>' +
        '<div class="main-content scroll-area">' +
          '<div class="scroll-inner">' +
            '<div style="height:16px"></div>' +
            '<div id="pc-timer-area"></div>' +
            '<div class="section-head">Screen Control</div>' +
            '<div class="action-grid" style="margin-bottom:20px">' +
              '<div class="action-card" onclick="PcControl.pcCmd(\'lock\')"><div class="action-card-icon"><i class="fa-solid fa-lock" style="color:var(--amber)"></i></div><div class="action-card-label">Lock</div></div>' +
              '<div class="action-card" onclick="PcControl.pcCmd(\'unlock\')"><div class="action-card-icon"><i class="fa-solid fa-lock-open" style="color:var(--green)"></i></div><div class="action-card-label">Unlock</div></div>' +
              '<div class="action-card" onclick="confirmAction(\'sleep\')"><div class="action-card-icon"><i class="fa-solid fa-moon" style="color:var(--blue)"></i></div><div class="action-card-label">Sleep</div></div>' +
              '<div class="action-card" onclick="confirmAction(\'shutdown\')"><div class="action-card-icon"><i class="fa-solid fa-power-off" style="color:var(--red)"></i></div><div class="action-card-label">Shutdown</div></div>' +
            '</div>' +
            '<div class="section-head">Applications</div>' +
            '<div class="action-grid" style="margin-bottom:20px">' +
              '<div class="action-card" onclick="PcControl.openApps()"><div class="action-card-icon"><i class="fa-solid fa-rocket" style="color:var(--blue)"></i></div><div class="action-card-label">Launch App</div><div class="action-card-sub">Open remotely</div></div>' +
              '<div class="action-card" onclick="PcControl.openKillSheet()"><div class="action-card-icon"><i class="fa-solid fa-skull-crossbones" style="color:var(--red)"></i></div><div class="action-card-label">Kill Task</div><div class="action-card-sub">End a running app</div></div>' +
            '</div>' +
            '<div id="pc-session-area"></div>' +
            '<div style="height:16px"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="sheet-bg" id="bg-startsession" onclick="closeSheet(\'sheet-startsession\')"></div>' +
    '<div class="sheet" id="sheet-startsession">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">Start Session</div>' +
      '<div class="sheet-sub">Choose duration or enter amount</div>' +
      '<div class="chip-row">' +
        '<div class="chip" onclick="PcControl.startSession(30)"><i class="fa-regular fa-clock"></i> 30m</div>' +
        '<div class="chip" onclick="PcControl.startSession(60)"><i class="fa-regular fa-clock"></i> 1h</div>' +
        '<div class="chip" onclick="PcControl.startSession(90)"><i class="fa-regular fa-clock"></i> 1.5h</div>' +
        '<div class="chip" onclick="PcControl.startSession(120)"><i class="fa-regular fa-clock"></i> 2h</div>' +
        '<div class="chip" onclick="PcControl.startSession(180)"><i class="fa-regular fa-clock"></i> 3h</div>' +
      '</div>' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin:16px 0 8px">Or Pay by Amount</div>' +
      '<div class="input-row" style="margin-bottom:16px">' +
        '<input type="text" id="session-amount" placeholder="Amount ($)" inputmode="decimal" pattern="[0-9]*" oninput="this.value=this.value.replace(/[^0-9.]/g,\'\')">' +
        '<input type="text" id="session-mins" placeholder="Minutes" inputmode="numeric" pattern="[0-9]*" oninput="this.value=this.value.replace(/[^0-9]/g,\'\')">' +
        '<button class="btn btn-primary" onclick="PcControl.startSessionByAmount()">Start</button>' +
      '</div>' +
      '<button onclick="PcControl.startStopwatch()" style="width:100%;padding:13px;border-radius:var(--r2);background:var(--amber-bg);border:1px solid var(--amber-bd);color:var(--amber);font-size:13px;font-weight:700;cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:8px"><i class="fa-solid fa-stopwatch"></i> Free Timer (Count Up)</button>' +
    '</div>' +
    '<div class="sheet-bg" id="bg-addtime" onclick="closeSheet(\'sheet-addtime\')"></div>' +
    '<div class="sheet" id="sheet-addtime">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">Add Time</div>' +
      '<div class="sheet-sub">Extend by duration or amount</div>' +
      '<div class="chip-row">' +
        '<div class="chip green" onclick="PcControl.addTime(30)"><i class="fa-solid fa-circle-plus"></i> 30m</div>' +
        '<div class="chip green" onclick="PcControl.addTime(60)"><i class="fa-solid fa-circle-plus"></i> 1h</div>' +
        '<div class="chip green" onclick="PcControl.addTime(90)"><i class="fa-solid fa-circle-plus"></i> 1.5h</div>' +
        '<div class="chip green" onclick="PcControl.addTime(120)"><i class="fa-solid fa-circle-plus"></i> 2h</div>' +
        '<div class="chip green" onclick="PcControl.addTime(180)"><i class="fa-solid fa-circle-plus"></i> 3h</div>' +
      '</div>' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin:16px 0 8px">Add Time</div>' +
      '<div class="input-row" style="margin-bottom:20px">' +
        '<input type="text" id="add-amount" placeholder="Amount ($)" inputmode="decimal" pattern="[0-9]*" oninput="this.value=this.value.replace(/[^0-9.]/g,\'\')">' +
        '<input type="text" id="add-mins" placeholder="Minutes" inputmode="numeric" pattern="[0-9]*" oninput="this.value=this.value.replace(/[^0-9]/g,\'\')">' +
        '<button class="btn btn-primary" onclick="PcControl.addTimeByAmount()">Add</button>' +
      '</div>' +
    '</div>' +
    '<div class="sheet-bg" id="bg-removetime" onclick="closeSheet(\'sheet-removetime\')"></div>' +
    '<div class="sheet" id="sheet-removetime">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-title" style="color:var(--red)">Remove Time</div>' +
      '<div class="sheet-sub">Reduce remaining session time</div>' +
      '<div class="chip-row">' +
        '<div class="chip red" onclick="PcControl.removeTime(15)"><i class="fa-solid fa-circle-minus"></i> 15m</div>' +
        '<div class="chip red" onclick="PcControl.removeTime(30)"><i class="fa-solid fa-circle-minus"></i> 30m</div>' +
        '<div class="chip red" onclick="PcControl.removeTime(60)"><i class="fa-solid fa-circle-minus"></i> 1h</div>' +
        '<div class="chip red" onclick="PcControl.removeTime(120)"><i class="fa-solid fa-circle-minus"></i> 2h</div>' +
      '</div>' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin:16px 0 8px">Remove Time</div>' +
      '<div class="input-row" style="margin-bottom:20px">' +
        '<input type="text" id="rem-mins" placeholder="Minutes to remove" inputmode="numeric" pattern="[0-9]*" oninput="this.value=this.value.replace(/[^0-9]/g,\'\')">' +
        '<button class="btn btn-danger" onclick="PcControl.removeTime(parseInt(this.previousElementSibling.value) || 0)">Remove</button>' +
      '</div>' +
    '</div>' +
    '<div class="sheet-bg" id="bg-apps" onclick="closeSheet(\'sheet-apps\')"></div>' +
    '<div class="sheet" id="sheet-apps">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-title-row">' +
        '<div class="sheet-title">Launch App</div>' +
        '<button class="btn btn-ghost btn-sm" onclick="PcControl.openApps()" style="padding:6px 12px;font-size:10px"><i class="fa-solid fa-rotate"></i> Refresh</button>' +
      '</div>' +
      '<div class="sheet-sub" id="apps-pc-name"></div>' +
      '<div id="apps-list"><div style="text-align:center;padding:28px"><span class="spin"></span></div></div>' +
    '</div>' +
    '<div class="sheet-bg" id="bg-killtasks" onclick="closeSheet(\'sheet-killtasks\')"></div>' +
    '<div class="sheet" id="sheet-killtasks">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-title-row">' +
        '<div class="sheet-title">Kill Task</div>' +
        '<button class="btn btn-danger btn-sm" onclick="PcControl.killAllProcesses()" style="padding:6px 12px;font-size:10px"><i class="fa-solid fa-skull"></i> Kill All</button>' +
      '</div>' +
      '<div class="sheet-sub" id="killtasks-pc-name"></div>' +
      '<div id="killtasks-list"><div style="text-align:center;padding:28px"><span class="spin"></span></div></div>' +
    '</div>';
  };
})();