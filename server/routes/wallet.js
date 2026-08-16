const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------- MY WALLET
router.get('/', requireAuth, (req, res) => {
  const wallet = db.get('wallets').find({ userId: req.user.id }).value() || { balance: 0, txns: [] };
  res.json({ balance: wallet.balance || 0, txns: wallet.txns || [] });
});

module.exports = router;
