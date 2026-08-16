const jwt = require('jsonwebtoken');
const db = require('../db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token || null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = db.get('users').find({ id: payload.uid }).value();
    if (!user) return res.status(401).json({ error: 'Session invalid. Please log in again.' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Admin access only.' });
  next();
}

function signToken(user) {
  return jwt.sign({ uid: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

module.exports = { requireAuth, requireAdmin, signToken };
