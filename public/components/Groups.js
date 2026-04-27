(function() {
  const Groups = window.Groups = {};

  async function fetchMe() {
    try {
      const res = await fetch(COMMON.serverUrl + '/api/me', {
        headers: { Authorization: 'Bearer ' + COMMON.token }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  Groups.load = async function() {
    let status = 'active';
    try {
      const me = await fetchMe();
      if (me) {
        status = me.status || 'active';
        COMMON.user = { ...COMMON.user, status: me.status, expiry_date: me.expiry_date };
      }
    } catch {}
    if (status !== 'active') { Groups.renderList(); Groups.checkExpiryWarning(); return; }
    try {
      window.groups = await api('GET', '/groups');
      sessionStorage.setItem('gz_groups', JSON.stringify(window.groups));
      Groups.renderList();
    } catch (e) {
      if (e.message === 'account_pending') { if (COMMON.user) COMMON.user.status = 'pending'; }
      else if (e.message === 'subscription_expired') { if (COMMON.user) COMMON.user.status = 'expired'; }
      else if (e.message === 'account_deactivated') { if (COMMON.user) COMMON.user.status = 'deactivated'; }
      else toast('Failed to load groups', 'err');
      Groups.renderList();
    }
    Groups.checkExpiryWarning();
  };

  Groups.renderList = function() {
    const el = document.getElementById('groups-list');
    if (!el) return;
    const status = COMMON.user?.status || 'active';
    if (status === 'pending') {
      el.innerHTML = '<div class="empty"><div class="empty-ico"><i class="fa-solid fa-clock" style="color:var(--amber)"></i></div><div class="empty-h">Account Pending Approval</div><div class="empty-p">Your account is awaiting approval from the provider.<br>Please contact them to get started.</div></div>';
      return;
    }
    if (status === 'expired') {
      el.innerHTML = '<div class="empty"><div class="empty-ico"><i class="fa-solid fa-calendar-xmark" style="color:var(--red)"></i></div><div class="empty-h">Subscription Expired</div><div class="empty-p">Please contact your provider to renew your subscription.</div></div>';
      return;
    }
    if (status === 'deactivated') {
      el.innerHTML = '<div class="empty"><div class="empty-ico"><i class="fa-solid fa-ban" style="color:var(--red)"></i></div><div class="empty-h">Account Deactivated</div><div class="empty-p">Your account has been deactivated. Please contact your provider.</div></div>';
      return;
    }
    const groups = window.groups || [];
    if (!groups.length) {
      el.innerHTML = '<div class="empty"><div class="empty-ico"><i class="fa-solid fa-store"></i></div><div class="empty-h">No groups yet</div><div class="empty-p">Create your first group to get started</div></div>';
      return;
    }
    el.innerHTML = Groups.groupItemsHtml(groups);
  };

  Groups.groupItemsHtml = function(groups) {
    return groups.map(g =>
      '<div class="group-item" data-group-id="' + g.id + '">' +
      '<div class="group-item-left">' +
      '<div class="group-item-icon"><i class="fa-solid fa-network-wired"></i></div>' +
      '<div><div class="group-item-name">' + escapeHtml(g.name) + '</div><div class="group-item-sub">Tap to manage</div></div>' +
      '</div>' +
      '<span class="group-item-arrow"><i class="fa-solid fa-chevron-right"></i></span>' +
      '</div>'
    ).join('');
  };

  Groups.groupItemClick = function(id) {
    const group = (window.groups || []).find(g => g.id === id);
    if (!group) return;
    sessionStorage.setItem('gz_activeGroup', JSON.stringify(group));
    window.currentGroupId = group.id;
    window.currentGroupName = group.name;
    navigateTo('dashboard');
  };

  Groups.checkExpiryWarning = function() {
    const banner = document.getElementById('expiry-banner');
    if (!banner) return;
    const expiry = COMMON.user?.expiry_date;
    if (!expiry) { banner.style.display = 'none'; return; }
    const daysLeft = Math.ceil((expiry - Date.now()) / 86400000);
    if (daysLeft > 0 && daysLeft <= 5) {
      banner.style.display = 'flex';
      const daysEl = document.getElementById('expiry-days');
      if (daysEl) daysEl.textContent = daysLeft;
    } else {
      banner.style.display = 'none';
    }
  };

  Groups.create = async function() {
    const nameEl = document.getElementById('newgroup-name');
    if (!nameEl) return;
    const name = nameEl.value.trim();
    if (!name) { toast('Enter a name', 'err'); return; }
    const btnText = document.getElementById('newgroup-btn-text');
    if (btnText) btnText.innerHTML = '<span class="spin"></span>';
    try {
      const g = await api('POST', '/groups', { name });
      if (!window.groups) window.groups = [];
      window.groups.push(g);
      Groups.renderList();
      closeSheet('sheet-newgroup');
      nameEl.value = '';
      toast('Group created', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { if (btnText) btnText.textContent = 'Create'; }
  };

  Groups.init = function() {
    document.getElementById('app').innerHTML = Groups.render();
    setTimeout(() => {
      const list = document.getElementById('groups-list');
      if (list) list.addEventListener('click', e => {
        const item = e.target.closest('.group-item');
        if (item) Groups.groupItemClick(item.dataset.groupId);
      });
      Groups.load();
    }, 0);
    return true;
  };

  Groups.render = function() {
    return '<div id="app" class="app-layout page-groups">' +
      '<div class="sidebar-col">' +
        '<div class="sidebar-header">' +
          '<div class="sidebar-brand"><div class="sidebar-brand-icon"><i class="fa-solid fa-gamepad"></i></div>GameZone</div>' +
          '<div class="sidebar-actions"><button class="icon-btn" onclick="doLogout()" title="Logout"><i class="fa-solid fa-right-from-bracket"></i></button></div>' +
        '</div>' +
        '<div id="expiry-banner" style="display:none;background:var(--amber-bg);border-bottom:1px solid var(--amber-bd);padding:9px 18px;align-items:center;gap:8px;font-size:11px;font-weight:600;color:var(--amber);flex-shrink:0">' +
          '<i class="fa-solid fa-triangle-exclamation"></i>' +
          '<span>Subscription expires in <strong id="expiry-days">0</strong> days — contact your provider to renew</span>' +
        '</div>' +
        '<div class="scroll-area"><div class="screen-pad" id="groups-list"></div></div>' +
        '<button class="fab" data-action="newgroup" onclick="openSheet(\'sheet-newgroup\')"><i class="fa-solid fa-plus"></i> New Group</button>' +
      '</div>' +
    '</div>' +
    '<div class="sheet-bg" id="bg-newgroup" onclick="closeSheet(\'sheet-newgroup\')"></div>' +
    '<div class="sheet" id="sheet-newgroup">' +
      '<div class="sheet-handle"></div>' +
      '<div class="sheet-title">New Group</div>' +
      '<div class="sheet-sub">Create a management group</div>' +
      '<div class="field"><label class="field-label">Name</label><input class="field-input" type="text" id="newgroup-name" placeholder="e.g. Main Cafe"></div>' +
      '<div class="sheet-btns">' +
        '<button class="btn btn-ghost" onclick="closeSheet(\'sheet-newgroup\')">Cancel</button>' +
        '<button class="btn btn-primary" onclick="Groups.create()"><span id="newgroup-btn-text">Create</span></button>' +
      '</div>' +
    '</div>';
  };
})();