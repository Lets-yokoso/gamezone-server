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

function disconnectSocket() {
  if (socket) { socket.disconnect(); socket = null; }
}

function getSocket() { return socket; }
