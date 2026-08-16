const express = require('express');
const db = require('../db');

const router = express.Router();

// ---------------------------------------------------------------- LIST ACTIVE SERVICES (public)
router.get('/', (req, res) => {
  const services = db.get('services').filter({ active: true }).value();
  res.json({ services });
});

module.exports = router;
