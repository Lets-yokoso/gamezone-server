const Settings = {
  render() {
    const group = JSON.parse(sessionStorage.getItem('gz_activeGroup') || 'null');
    if (!group) {
      navigateTo('groups');
      return '';
    }
    
    window.currentGroupId = group.id;
    window.currentGroupName = group.name;
    
    return `
      <div class="main-col">
        <div class="topbar">
          <button class="back-btn" onclick="navigateTo('dashboard/' + (JSON.parse(sessionStorage.getItem('gz_activeGroup')||'null')?.group_suffix||''))"><i class="fa-solid fa-chevron-left"></i></button>
          <div class="topbar-title">Settings</div>
          <div style="width:34px"></div>
        </div>
        <div class="main-content scroll-area">
          <div class="scroll-inner">
            <div class="screen-pad">
              <div class="settings-card">
                <div class="settings-row"><div><div class="settings-key">Group Name</div><div id="s-name" class="settings-val">${escapeHtml(group.name)}</div></div></div>
                <div class="settings-row"><div style="width:100%"><div class="settings-key">Group ID</div><div id="s-id" class="mono-block">${escapeHtml(group.id)}</div><div style="font-size:10px;color:var(--t3);margin-top:5px">Copy into each PC's config.json</div></div></div>
                <div class="settings-row">
                  <div><div class="settings-key">Hourly Rate (Rs)</div><div class="settings-val">Price per hour for all PCs in this group</div></div>
                  <div style="display:flex;align-items:center;gap:8px">
                    <input type="text" id="group-rate-input" placeholder="5.00" inputmode="decimal" pattern="[0-9]*" oninput="this.value=this.value.replace(/[^0-9.]/g,'')" style="width:80px;background:var(--bg);border:1px solid var(--bd);border-radius:var(--r);padding:8px 10px;font-size:13px;color:var(--t1);outline:none">
                    <button class="btn btn-primary btn-sm" onclick="handleSaveGroupRate()" style="padding:8px 14px;font-size:11px">Save</button>
                  </div>
                </div>
                <div style="background:var(--amber-bg);border:1px solid var(--amber-bd);border-radius:var(--r);padding:12px;margin:12px 0;font-size:11px;color:var(--amber)">
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><i class="fa-solid fa-triangle-exclamation"></i><strong>History will be deleted daily</strong></div>
                  <div>PC usage history is cleared daily at <strong id="flush-warning-time">03:30</strong> (Singapore time). Download history before this time to keep records.</div>
                </div>
              </div>
              <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:12px">Administrators</div>
              <div id="admins-list"></div>
              <button class="btn btn-ghost" style="margin-top:12px" onclick="openSheet('sheet-addadmin')"><i class="fa-solid fa-user-plus"></i> Add Admin</button>
              <div style="height:20px"></div>
              <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:12px">Preferences</div>
              <div class="settings-card" style="margin-bottom:20px">
                <div class="settings-row" style="cursor:pointer" onclick="togglePref('hideAddGroup')">
                  <div><div class="settings-key">Hide "New Group" Button</div><div class="settings-val">Remove the button once groups are set up</div></div>
                  <div id="pref-hideAddGroup" style="width:36px;height:20px;border-radius:10px;background:var(--s4);position:relative;transition:background .2s;flex-shrink:0;margin-top:2px">
                    <div style="width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:2px;transition:transform .2s"></div>
                  </div>
                </div>
                <div class="settings-row" style="cursor:pointer" onclick="togglePref('hideAddPC')">
                  <div><div class="settings-key">Hide "Add PC" Button</div><div class="settings-val">Remove the button once PCs are configured</div></div>
                  <div id="pref-hideAddPC" style="width:36px;height:20px;border-radius:10px;background:var(--s4);position:relative;transition:background .2s;flex-shrink:0;margin-top:2px">
                    <div style="width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:2px;left:2px;transition:transform .2s"></div>
                  </div>
                </div>
              </div>
              <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:12px">Danger Zone</div>
              <div style="display:flex;flex-direction:column;gap:10px">
                <button class="btn btn-ghost" onclick="openSheet('sheet-reorderpc')"><i class="fa-solid fa-arrows-up-down"></i> Reorder PCs</button>
                <button class="btn btn-ghost" onclick="openSheet('sheet-deletepc')"><i class="fa-solid fa-trash"></i> Delete a PC</button>
                <button class="btn btn-danger btn-full" onclick="confirmDeleteGroup()"><i class="fa-solid fa-trash-can"></i> Delete Group</button>
                <button class="btn btn-danger btn-full" onclick="doLogout()"><i class="fa-solid fa-right-from-bracket"></i> Logout</button>
              </div>
              <div style="height:24px"></div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="sheet-bg" id="bg-addadmin" onclick="closeSheet('sheet-addadmin')"></div>
      <div class="sheet" id="sheet-addadmin">
        <div class="sheet-handle"></div>
        <div class="sheet-title">Add Admin</div>
        <div class="sheet-sub">Grant access to another user</div>
        <div class="field"><label class="field-label">Username</label><input class="field-input" type="text" id="addadmin-user" placeholder="Username" autocapitalize="none"></div>
        <div class="sheet-btns">
          <button class="btn btn-ghost" onclick="closeSheet('sheet-addadmin')">Cancel</button>
          <button class="btn btn-primary" onclick="addAdmin()"><span id="addadmin-btn-text">Add Admin</span></button>
        </div>
      </div>
      
      <div class="sheet-bg" id="bg-reorderpc" onclick="closeSheet('sheet-reorderpc')"></div>
      <div class="sheet" id="sheet-reorderpc">
        <div class="sheet-handle"></div>
        <div class="sheet-title">Reorder PCs</div>
        <div class="sheet-sub">Use arrows to change display order</div>
        <div id="reorder-pc-list"><div style="text-align:center;padding:20px"><span class="spin"></span></div></div>
      </div>
      
      <div class="sheet-bg" id="bg-deletepc" onclick="closeSheet('sheet-deletepc')"></div>
      <div class="sheet" id="sheet-deletepc">
        <div class="sheet-handle"></div>
        <div class="sheet-title">Delete PC</div>
        <div class="sheet-sub">Select a PC to remove permanently</div>
        <div id="delete-pc-list"><div style="text-align:center;padding:20px"><span class="spin"></span></div></div>
      </div>
    `;
  },
  
  init() {
    document.getElementById('group-rate-input').value = getGroupRate(window.currentGroupId).toFixed(2);
    loadSettingsPCs();
    loadAdmins();
    applyPrefs();
  },
  
  destroy() {
    window.currentGroupId = null;
    window.currentGroupName = null;
  }
};

window.SettingsComponent = Settings;

function loadSettingsPCs() {
  if (!window.currentGroupId) return;
  api('GET', '/groups/' + window.currentGroupId + '/pcs').then(pcs => {
    window.pcs = pcs;
    renderDeletePCList();
    renderReorderPCList();
  }).catch(() => toast('Failed to load PCs', 'err'));
}

function loadAdmins() {
  if (!window.currentGroupId) return;
  api('GET', '/groups/' + window.currentGroupId + '/admins').then(admins => {
    document.getElementById('admins-list').innerHTML = admins.length
      ? admins.map(a => '<div class="admin-row"><div class="admin-av">' + escapeHtml(a.username[0].toUpperCase()) + '</div><div class="admin-name">' + escapeHtml(a.username) + '</div><button class="remove-btn" onclick="removeAdmin(\'' + a.id + '\',\'' + escapeHtml(a.username) + '\')">Remove</button></div>').join('')
      : '<div style="color:var(--t2);padding:8px 0;font-size:12px">No additional admins</div>';
  }).catch(() => {});
}

function addAdmin() {
  const username = document.getElementById('addadmin-user').value.trim();
  if (!username) { toast('Enter a username', 'err'); return; }
  document.getElementById('addadmin-btn-text').innerHTML = '<span class="spin"></span>';
  api('POST', '/groups/' + window.currentGroupId + '/admins', { username }).then(() => {
    closeSheet('sheet-addadmin');
    document.getElementById('addadmin-user').value = '';
    toast(username + ' added', 'ok');
    loadAdmins();
  }).catch(e => toast(e.message, 'err')).finally(() => {
    document.getElementById('addadmin-btn-text').textContent = 'Add Admin';
  });
}

function removeAdmin(id, username) {
  showModal('Remove Admin?', 'Remove ' + escapeHtml(username) + ' as admin?', 'remove-admin');
  document.getElementById('modal-confirm-btn').textContent = 'Remove';
  window._modalState = { type: 'remove-admin', adminId: id, adminName: username };
}

function renderDeletePCList() {
  const el = document.getElementById('delete-pc-list');
  if (!el) return;
  const pcs = window.pcs || [];
  if (!pcs.length) { el.innerHTML = '<div style="color:var(--t2);padding:8px 0;font-size:12px">No PCs in this group</div>'; return; }
  el.innerHTML = pcs.map(pc =>
    '<div class="pc-del-row">' +
    '<div class="pc-del-name"><i class="fa-solid fa-computer" style="color:var(--t3)"></i>' + escapeHtml(pc.name) + '</div>' +
    '<button class="pc-del-btn" onclick="promptDeletePC(\'' + pc.id + '\',\'' + escapeHtml(pc.name) + '\')">Delete</button>' +
    '</div>'
  ).join('');
}

function renderReorderPCList() {
  const el = document.getElementById('reorder-pc-list');
  if (!el) return;
  const pcs = window.pcs || [];
  if (!pcs.length) { el.innerHTML = '<div style="color:var(--t2);padding:8px 0;font-size:12px">No PCs in this group</div>'; return; }
  el.innerHTML = pcs.map((pc, idx) =>
    '<div class="pc-del-row">' +
    '<div class="pc-del-name"><i class="fa-solid fa-computer" style="color:var(--t3)"></i>' + escapeHtml(pc.name) + '</div>' +
    '<div class="reorder-btns">' +
    '<button class="reorder-btn" onclick="reorderPC(\'' + pc.id + '\',-1)"' + (idx === 0 ? ' disabled' : '') + ' title="Move up"><i class="fa-solid fa-chevron-up"></i></button>' +
    '<button class="reorder-btn" onclick="reorderPC(\'' + pc.id + '\',1)"' + (idx === pcs.length - 1 ? ' disabled' : '') + ' title="Move down"><i class="fa-solid fa-chevron-down"></i></button>' +
    '</div></div>'
  ).join('');
}

function reorderPC(pcId, direction) {
  const idx = window.pcs.findIndex(p => p.id === pcId);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= window.pcs.length) return;
  [window.pcs[idx], window.pcs[newIdx]] = [window.pcs[newIdx], window.pcs[idx]];
  const order = window.pcs.map((pc, i) => ({ pc_id: pc.id, order: i }));
  renderReorderPCList();
  api('POST', '/groups/' + window.currentGroupId + '/pcs/reorder', { order }).catch(() => toast('Reorder failed', 'err'));
}

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