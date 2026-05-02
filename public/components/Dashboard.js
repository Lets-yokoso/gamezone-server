(function() {
  const Dashboard = window.Dashboard = {};
  let _socket = null;
  let _timerInterval = null;

  async function loadPCs() {
    try {
      window.pcs = await api('GET', '/groups/' + window.currentGroupId + '/pcs');
      const needsOrder = window.pcs.some(p => p.order === undefined || p.order === null);
      if (needsOrder) {
        window.pcs.forEach((pc, i) => pc.order = i);
        await api('POST', '/groups/' + window.currentGroupId + '/pcs/reorder', { order: window.pcs.map((pc, i) => ({ pc_id: pc.id, order: i })) }).catch(() => {});
      }
      Dashboard.renderPCGrid();
      Dashboard.renderSidebarGroups();
      applyPrefs();
    } catch { toast('Failed to load PCs', 'err'); }
  }

  Dashboard.renderPCGrid = function() {
    const now = Math.floor(Date.now() / 1000);
    const pcs = window.pcs || [];
    const online = pcs.filter(p => p.is_online).length;
    const active = pcs.filter(p => p.session_end > now || p.stopwatch_start > 0).length;
    const statTotal = document.getElementById('stat-total');
    const statOnline = document.getElementById('stat-online');
    const statActive = document.getElementById('stat-active');
    if (statTotal) statTotal.textContent = pcs.length;
    if (statOnline) statOnline.textContent = online;
    if (statActive) statActive.textContent = active;
    const grid = document.getElementById('pc-grid');
    if (!grid) return;
    if (!pcs.length) {
      grid.innerHTML = '<div style="grid-column:1/-1"><div class="empty"><div class="empty-ico"><i class="fa-solid fa-desktop"></i></div><div class="empty-h">No PCs yet</div><div class="empty-p">Tap "+ Add PC" to register one</div></div></div>';
      return;
    }
    grid.innerHTML = pcs.map(pc => {
      const left = pc.session_end > now ? pc.session_end - now : 0;
      const isWatch = pc.stopwatch_start > 0;
      const col = !pc.is_online ? 'var(--t3)' : isWatch ? 'var(--blue)' : left > 300 ? 'var(--green)' : left > 0 ? 'var(--amber)' : 'var(--red)';
      const bg = !pc.is_online ? 'var(--s3)' : isWatch ? 'var(--blue-bg)' : left > 300 ? 'var(--green-bg)' : left > 0 ? 'var(--amber-bg)' : 'var(--red-bg)';
      const bd = !pc.is_online ? 'var(--bd)' : isWatch ? 'var(--blue-bd)' : left > 300 ? 'var(--green-bd)' : left > 0 ? 'var(--amber-bd)' : 'var(--red-bd)';
      const hasSession = left > 0 || isWatch;
      const status = !hasSession ? (pc.is_online ? 'Idle' : 'Offline') : isWatch ? 'Free' : 'Active';
      const elapsed = isWatch ? now - pc.stopwatch_start : 0;
      const timer = !hasSession ? (pc.is_online ? '--:--' : '- - -') : isWatch ? fmtTime(elapsed) : fmtTime(left);
      const pay = pc.payment_status || '';
      const payBadge = pay === 'paid' ? '<span class="pay-badge" style="background:var(--green-bg);color:var(--green)"><i class="fa-solid fa-check"></i> Paid</span>' : pay === 'unpaid' ? '<span class="pay-badge" style="background:var(--red-bg);color:var(--red)"><i class="fa-solid fa-xmark"></i> Unpaid</span>' : '';
      return '<div class="pc-card" data-pc-id="' + pc.id + '" style="--pc-color:' + col + ';--pc-bg:' + bg + ';--pc-bd:' + bd + '">' +
        '<div class="pc-card-top"><div class="pc-card-name"><i class="fa-solid fa-computer"></i>' + escapeHtml(pc.name) + '</div><div class="pc-dot"></div></div>' +
        '<div class="pc-timer">' + timer + '</div>' +
        '<div class="pc-footer"><span class="pc-badge">' + status + '</span>' + payBadge + '</div>' +
      '</div>';
    }).join('');
  };

  Dashboard.renderSidebarGroups = function() {
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

  function updateTimers() {
    const now = Math.floor(Date.now() / 1000);
    document.querySelectorAll('.pc-card').forEach(cardEl => {
      const pcId = cardEl.getAttribute('data-pc-id');
      if (!pcId) return;
      const pc = window.pcs.find(p => p.id === pcId);
      if (!pc) return;
      const left = pc.session_end > now ? pc.session_end - now : 0;
      const isWatch = pc.stopwatch_start > 0;
      const elapsed = isWatch ? now - pc.stopwatch_start : 0;
      const timerEl = cardEl.querySelector('.pc-timer');
      if (timerEl) timerEl.textContent = isWatch ? fmtTime(elapsed) : left > 0 ? fmtTime(left) : '--:--';
      const col = !pc.is_online ? 'var(--t3)' : isWatch ? 'var(--blue)' : left > 300 ? 'var(--green)' : left > 0 ? 'var(--amber)' : 'var(--red)';
      const bg = !pc.is_online ? 'var(--s3)' : isWatch ? 'var(--blue-bg)' : left > 300 ? 'var(--green-bg)' : left > 0 ? 'var(--amber-bg)' : 'var(--red-bg)';
      const bd = !pc.is_online ? 'var(--bd)' : isWatch ? 'var(--blue-bd)' : left > 300 ? 'var(--green-bd)' : left > 0 ? 'var(--amber-bd)' : 'var(--red-bd)';
      cardEl.style.setProperty('--pc-color', col);
      cardEl.style.setProperty('--pc-bg', bg);
      cardEl.style.setProperty('--pc-bd', bd);
      const badge = cardEl.querySelector('.pc-badge');
      if (badge) {
        const hasSession = left > 0 || isWatch;
        const status = !hasSession ? (pc.is_online ? 'Idle' : 'Offline') : isWatch ? 'Free' : 'Active';
        badge.textContent = status;
        badge.style.color = col;
        badge.style.background = bg;
        badge.style.borderColor = bd;
      }
    });
  }

  function handleStatusUpdate(data) {
    const pc = window.pcs.find(p => p.id === data.pc_id);
    if (pc) { pc.is_online = data.is_online ? 1 : 0; Dashboard.renderPCGrid(); }
  }

  function handleSessionUpdate(data) {
    const pc = window.pcs.find(p => p.id === data.pc_id);
    if (!pc) return;
    if ('session_end' in data) pc.session_end = data.session_end;
    if ('stopwatch_start' in data) pc.stopwatch_start = data.stopwatch_start;
    if ('payment_status' in data) pc.payment_status = data.payment_status;
    Dashboard.renderPCGrid();
  }

  Dashboard.switchGroup = function(id) {
    api('GET', '/groups').then(groups => {
      sessionStorage.setItem('gz_groups', JSON.stringify(groups));
      const group = groups.find(g => g.id === id);
      if (group) {
        sessionStorage.setItem('gz_activeGroup', JSON.stringify(group));
        window.currentGroupId = group.id;
        window.currentGroupName = group.name;
        navigateTo('dashboard/' + (group.group_suffix || ''));
      }
    }).catch(() => navigateTo('groups'));
  };

  Dashboard.openPC = function(id) {
    const pc = window.pcs.find(p => p.id === id);
    if (!pc) return;
    sessionStorage.setItem('gz_activePc', JSON.stringify(pc));
    sessionStorage.setItem('gz_activeGroupId', window.currentGroupId);
    window.currentPcId = pc.id;
    window.currentPcName = pc.name;
    window.pc = pc;
    navigateTo('pc-control');
  };

  Dashboard.addPC = async function() {
    const name = document.getElementById('addpc-name').value.trim();
    const password = document.getElementById('addpc-pass').value;
    if (!name || !password) { toast('Name and password required', 'err'); return; }
    const btnText = document.getElementById('addpc-btn-text');
    if (btnText) btnText.innerHTML = '<span class="spin"></span>';
    try {
      const pc = await api('POST', '/groups/' + window.currentGroupId + '/pcs', { name, password });
      window.pcs.push(pc);
      Dashboard.renderPCGrid();
      closeSheet('sheet-addpc');
      document.getElementById('addpc-name').value = '';
      document.getElementById('addpc-pass').value = '';
      toast('PC added', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { if (btnText) btnText.textContent = 'Add PC'; }
  };

  Dashboard.connectSocket = function() {
    if (_socket) _socket.disconnect();
    _socket = io(COMMON.serverUrl, { transports: ['websocket'], reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
    _socket.on('connect', () => { _socket.emit('admin:subscribe', { group_id: window.currentGroupId, token: COMMON.token }); });
    _socket.on('group:' + window.currentGroupId + ':pc-status', handleStatusUpdate);
    _socket.on('group:' + window.currentGroupId + ':pc-session', handleSessionUpdate);
  };

  Dashboard.disconnectSocket = function() {
    if (_socket) { _socket.disconnect(); _socket = null; }
  };

  Dashboard.start = function() {
    const group = JSON.parse(sessionStorage.getItem('gz_activeGroup') || 'null');
    if (!group) { navigateTo('groups'); return; }
    window.currentGroupId = group.id;
    window.currentGroupName = group.name;
    document.getElementById('app').innerHTML = Dashboard.render(group.name);
    setTimeout(() => {
      const grid = document.getElementById('pc-grid');
      if (grid) {
        grid.addEventListener('click', e => {
          const card = e.target.closest('.pc-card');
          if (card) Dashboard.openPC(card.dataset.pcId);
        });
      }
      const sidebar = document.getElementById('sidebar-groups');
      if (sidebar) {
        sidebar.addEventListener('click', e => {
          const item = e.target.closest('.group-item');
          if (item) Dashboard.switchGroup(item.dataset.groupId);
        });
      }
      loadPCs();
      Dashboard.connectSocket();
      _timerInterval = setInterval(updateTimers, 1000);
    }, 0);
    return true;
  };

  Dashboard.cleanup = function() {
    Dashboard.disconnectSocket();
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  };

  Dashboard.render = function(groupName) {
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
          '<button class="back-btn" onclick="navigateTo(\'groups\')"><i class="fa-solid fa-chevron-left"></i> Back</button>' +
          '<div class="topbar-title" id="dash-title">' + escapeHtml(groupName) + '</div>' +
          '<button class="icon-btn" onclick="navigateTo(\'settings\')"><i class="fa-solid fa-gear"></i></button>' +
        '</div>' +
        '<div class="main-content scroll-area">' +
          '<div class="scroll-inner">' +
            '<div class="stats-row">' +
              '<div class="stat-box"><div class="stat-val" id="stat-total">0</div><div class="stat-key">Total</div></div>' +
              '<div class="stat-box"><div class="stat-val" id="stat-online" style="color:var(--green)">0</div><div class="stat-key">Online</div></div>' +
              '<div class="stat-box"><div class="stat-val" id="stat-active" style="color:var(--amber)">0</div><div class="stat-key">Active</div></div>' +
            '</div>' +
            '<div class="pc-grid" id="pc-grid"></div>' +
          '</div>' +
        '</div>' +
        (getPrefs().hideAddPC ? '' : '<button class="fab" data-action="addpc" onclick="openSheet(\'sheet-addpc\')"><i class="fa-solid fa-plus"></i> Add PC</button>') +
      '</div>' +
    '</div>' +
    '<div class="sheet-bg" id="bg-addpc" onclick="closeSheet(\'sheet-addpc\')"></div>' +
    '<div class="sheet" id="sheet-addpc">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">Add PC</div>' +
      '<div class="sheet-sub">Register a new computer to this group</div>' +
      '<div class="field"><label class="field-label">PC Name</label><input class="field-input" type="text" id="addpc-name" placeholder="e.g. PC-01"></div>' +
      '<div class="field"><label class="field-label">Password</label><input class="field-input" type="password" id="addpc-pass" placeholder="Set access password"></div>' +
      '<div class="sheet-btns">' +
        '<button class="btn btn-ghost" onclick="closeSheet(\'sheet-addpc\')">Cancel</button>' +
        '<button class="btn btn-primary" onclick="Dashboard.addPC()"><span id="addpc-btn-text">Add PC</span></button>' +
      '</div>' +
    '</div>';
  };
})();