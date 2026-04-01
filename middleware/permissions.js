const db = require('../db');

async function canManageGroup(userId, groupId) {
  const group = await db.get('groups', g => g.id === groupId);
  if (!group) return false;
  if (group.owner_id === userId) return true;
  return !!(await db.get('group_members', m => m.group_id === groupId && m.user_id === userId));
}

module.exports = {
  canManageGroup
};
