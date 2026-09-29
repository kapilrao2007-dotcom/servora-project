const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------- SUBMIT CONTACT MESSAGE (public)
router.post('/', (req, res) => {
  const { name, phone, email, role, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  const record = {
    id: nanoid(), name: name.trim(), phone: (phone||'').trim(), email: email.trim(),
    role: role || 'Customer', message: message.trim(), status: 'new', createdAt: Date.now()
  };
  db.get('contactMessages').push(record).write();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- ADMIN: list contact messages
router.get('/admin/list', requireAuth, requireAdmin, (req, res) => {
  const list = db.get('contactMessages').sortBy(m => -m.createdAt).value();
  res.json({ messages: list });
});

// ---------------------------------------------------------------- ADMIN: mark as read
router.post('/admin/:id/read', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('contactMessages').find({ id: req.params.id });
  if (!record.value()) return res.status(404).json({ error: 'Not found.' });
  record.assign({ status: 'read' }).write();
  res.json({ ok: true });
});

module.exports = router;