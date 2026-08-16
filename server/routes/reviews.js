const express = require('express');
const db = require('../db');

const router = express.Router();

// ---------------------------------------------------------------- FEATURED REVIEWS (public, for homepage testimonials)
// Highest-rated recent reviews with a written comment, across all professionals.
router.get('/featured', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 6, 20);
  const reviews = db.get('reviews')
    .filter(r => r.rating >= 4 && r.comment && r.comment.trim().length > 0)
    .sortBy(r => -r.createdAt)
    .value();

  const users = db.get('users').value();
  const professionals = db.get('professionals').value();
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  const proMap = Object.fromEntries(professionals.map(p => [p.id, p]));

  const enriched = reviews.slice(0, limit).map(r => ({
    rating: r.rating,
    comment: r.comment,
    customerName: userMap[r.userId]?.name || 'SERVORA Customer',
    service: proMap[r.professionalId]?.category || '',
    city: proMap[r.professionalId]?.city || '',
    createdAt: r.createdAt
  }));

  res.json({ reviews: enriched });
});

module.exports = router;
