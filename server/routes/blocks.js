const express = require('express');
const db = require('../db');

const router = express.Router();

// ---------------------------------------------------------------- LIST ACTIVE BLOCKS/AREAS (public)
router.get('/', (req, res) => {
  const blocks = db.get('blocks').filter({ active: true }).value();
  res.json({ blocks });
});

module.exports = router;
