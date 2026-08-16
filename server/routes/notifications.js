const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------- LIST MY NOTIFICATIONS
router.get('/', requireAuth, (req, res) => {
  const list = db.get('notifications')
    .filter({ userId: req.user.id })
    .sortBy(n => -n.createdAt)
    .take(30)
    .value();
  const unreadCount = db.get('notifications').filter({ userId: req.user.id, read: false }).size().value();
  res.json({ notifications: list, unreadCount });
});

// ---------------------------------------------------------------- MARK ONE READ
router.post('/:id/read', requireAuth, (req, res) => {
  const record = db.get('notifications').find({ id: req.params.id, userId: req.user.id });
  if (!record.value()) return res.status(404).json({ error: 'Notification not found.' });
  record.assign({ read: true }).write();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- MARK ALL READ
router.post('/read-all', requireAuth, (req, res) => {
  db.get('notifications').filter({ userId: req.user.id, read: false }).each(n => { n.read = true; }).write();
  res.json({ ok: true });
});

module.exports = router;
