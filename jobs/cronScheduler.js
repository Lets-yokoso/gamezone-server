const db = require('../db');

function initCronScheduler() {
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
  }, 300000);

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
  }, 60000);
}

module.exports = {
  initCronScheduler
};
