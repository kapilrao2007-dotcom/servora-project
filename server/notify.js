const { nanoid } = require('nanoid');
const db = require('./db');

/**
 * Creates a notification for a user. Call this at any point in the backend
 * where something happens that the user should know about.
 */
function notify(userId, type, title, message, link = null) {
  if (!userId) return;
  const record = {
    id: nanoid(), userId, type, title, message, link,
    read: false, createdAt: Date.now()
  };
  db.get('notifications').push(record).write();
  return record;
}

module.exports = { notify };
