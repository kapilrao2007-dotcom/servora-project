const express = require('express');
const Razorpay = require('razorpay');
const { nanoid } = require('nanoid');
const { asyncHandler } = require('../utils/asyncHandler');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notify } = require('../notify');

const router = express.Router();

const razorpayLive = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const rzp = razorpayLive
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

const PAID_STATUSES = ['confirmed_escrow', 'completed'];

// ---------------------------------------------------------------- EARNINGS SUMMARY
router.get('/earnings', requireAuth, requireAdmin, (req, res) => {
  const bookings = db.get('bookings').filter(b => PAID_STATUSES.includes(b.status)).value();
  const users = db.get('users').value();
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  const totalCollected = bookings.reduce((a, b) => a + b.price, 0);
  const totalCommission = bookings.reduce((a, b) => a + (b.commission || Math.round(b.price * 0.15)), 0);
  const totalOwedToProfessionals = bookings.reduce((a, b) => a + (b.professionalPayout || (b.price - Math.round(b.price * 0.15))), 0);

  const rows = bookings
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(b => ({
      bookingId: b.id,
      customerName: userMap[b.userId]?.name || 'Unknown',
      customerMobile: userMap[b.userId]?.mobile || '',
      service: b.service,
      amount: b.price,
      commission: b.commission || Math.round(b.price * 0.15),
      professionalPayout: b.professionalPayout || (b.price - Math.round(b.price * 0.15)),
      status: b.status,
      razorpayPaymentId: b.razorpayPaymentId,
      date: b.createdAt
    }));

  res.json({
    summary: {
      totalBookings: bookings.length,
      totalCollected,
      totalCommission,
      totalOwedToProfessionals
    },
    rows
  });
});

// ---------------------------------------------------------------- CSV EXPORT (for manual bank/UPI payout runs)
router.get('/earnings/export.csv', requireAuth, requireAdmin, (req, res) => {
  const bookings = db.get('bookings').filter(b => PAID_STATUSES.includes(b.status)).value();
  const users = db.get('users').value();
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  const header = 'Booking ID,Date,Customer,Service,Amount Paid,Platform Commission,Professional Payout,Payment ID,Status\n';
  const lines = bookings.map(b => {
    const c = b.commission || Math.round(b.price * 0.15);
    const p = b.professionalPayout || (b.price - c);
    const name = (userMap[b.userId]?.name || 'Unknown').replace(/,/g, ' ');
    return [b.id, new Date(b.createdAt).toISOString(), name, b.service, b.price, c, p, b.razorpayPaymentId || '', b.status].join(',');
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="servora-earnings-${Date.now()}.csv"`);
  res.send(header + lines.join('\n'));
});

// ---------------------------------------------------------------- REFUND REQUESTS
router.get('/refund-requests', requireAuth, requireAdmin, (req, res) => {
  const status = req.query.status;
  let list = db.get('refundRequests').value();
  if (status) list = list.filter(r => r.status === status);
  const bookings = db.get('bookings').value();
  const users = db.get('users').value();
  const bookingMap = Object.fromEntries(bookings.map(b => [b.id, b]));
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  const enriched = list
    .sort((a, b) => b.requestedAt - a.requestedAt)
    .map(r => ({ ...r, service: bookingMap[r.bookingId]?.service, customerName: userMap[r.userId]?.name || 'Unknown' }));
  res.json({ refundRequests: enriched });
});

router.post('/refund-requests/:id/approve', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const request = db.get('refundRequests').find({ id: req.params.id });
  const record = request.value();
  if (!record) return res.status(404).json({ error: 'Refund request not found.' });
  if (record.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided.' });

  const booking = db.get('bookings').find({ id: record.bookingId });
  const bookingRecord = booking.value();
  if (!bookingRecord) return res.status(404).json({ error: 'Linked booking not found.' });

  let refundId = null, refundStatus = 'dev_mode';
  const isDevPayment = !bookingRecord.razorpayPaymentId || bookingRecord.razorpayPaymentId.startsWith('DEV_');

  if (razorpayLive && !isDevPayment) {
    try {
      const refund = await rzp.payments.refund(bookingRecord.razorpayPaymentId, {
        amount: Math.round(record.amount * 100),
        speed: 'normal',
        notes: { reason: record.reason, bookingId: bookingRecord.id }
      });
      refundId = refund.id;
      refundStatus = refund.status;
    } catch (e) {
      console.error('Razorpay refund failed:', e);
      return res.status(502).json({ error: 'Razorpay refund failed. Please retry or contact Razorpay support.' });
    }
  }

  request.assign({ status: 'approved', decidedAt: Date.now() }).write();
  booking.assign({ status: 'refunded', refundId, refundStatus, refundedAt: Date.now() }).write();
  notify(record.userId, 'refund_approved', 'Refund approved', `Your refund of ₹${record.amount} for ${bookingRecord.service} has been approved.`, '/#/dashboard');
  res.json({ ok: true, refundStatus });
}));

router.post('/refund-requests/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const request = db.get('refundRequests').find({ id: req.params.id });
  const record = request.value();
  if (!record) return res.status(404).json({ error: 'Refund request not found.' });
  request.assign({ status: 'rejected', decidedAt: Date.now(), rejectReason: req.body.reason || '' }).write();
  notify(record.userId, 'refund_rejected', 'Refund request declined', `Your refund request for ₹${record.amount} was not approved.${req.body.reason ? ' Reason: '+req.body.reason : ''}`, '/#/dashboard');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- WITHDRAWAL REQUESTS
router.get('/withdrawals', requireAuth, requireAdmin, (req, res) => {
  const status = req.query.status;
  let list = db.get('withdrawals').value();
  if (status) list = list.filter(w => w.status === status);
  const pros = db.get('professionals').value();
  const proMap = Object.fromEntries(pros.map(p => [p.id, p]));
  const enriched = list
    .sort((a, b) => b.requestedAt - a.requestedAt)
    .map(w => ({ ...w, professionalName: proMap[w.professionalId]?.name || 'Unknown', category: proMap[w.professionalId]?.category || '' }));
  res.json({ withdrawals: enriched });
});

router.post('/withdrawals/:id/mark-paid', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('withdrawals').find({ id: req.params.id });
  const w = record.value();
  if (!w) return res.status(404).json({ error: 'Withdrawal request not found.' });
  record.assign({ status: 'paid', paidAt: Date.now() }).write();
  const pro = db.get('professionals').find({ id: w.professionalId }).value();
  if (pro) notify(pro.userId, 'withdrawal_paid', 'Withdrawal paid', `Your withdrawal of ₹${w.amount} has been sent to ${w.payoutTo}.`, '/#/pro-dashboard');
  res.json({ ok: true });
});

router.post('/withdrawals/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('withdrawals').find({ id: req.params.id });
  const w = record.value();
  if (!w) return res.status(404).json({ error: 'Withdrawal request not found.' });
  record.assign({ status: 'rejected', rejectedAt: Date.now() }).write();
  const pro = db.get('professionals').find({ id: w.professionalId }).value();
  if (pro) notify(pro.userId, 'withdrawal_rejected', 'Withdrawal request declined', `Your withdrawal request of ₹${w.amount} was not approved. Contact support for details.`, '/#/pro-dashboard');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- SERVICES MANAGEMENT
router.get('/services', requireAuth, requireAdmin, (req, res) => {
  res.json({ services: db.get('services').value() });
});

router.post('/services', requireAuth, requireAdmin, (req, res) => {
  const { icon, name, desc, tag, price } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price are required.' });
  const existing = db.get('services').find(s => s.name.toLowerCase() === name.toLowerCase()).value();
  if (existing) return res.status(409).json({ error: 'A service with this name already exists.' });

  const service = {
    id: 'svc_' + nanoid(8), icon: icon || 'fa-screwdriver-wrench', name,
    desc: desc || '', tag: tag || 'other', price: Number(price), active: true
  };
  db.get('services').push(service).write();
  res.json({ ok: true, service });
});

router.patch('/services/:id', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('services').find({ id: req.params.id });
  if (!record.value()) return res.status(404).json({ error: 'Service not found.' });
  const { icon, name, desc, tag, price, active } = req.body;
  const updates = {};
  if (icon !== undefined) updates.icon = icon;
  if (name !== undefined) updates.name = name;
  if (desc !== undefined) updates.desc = desc;
  if (tag !== undefined) updates.tag = tag;
  if (price !== undefined) updates.price = Number(price);
  if (active !== undefined) updates.active = !!active;
  record.assign(updates).write();
  res.json({ ok: true, service: record.value() });
});

router.delete('/services/:id', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('services').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Service not found.' });
  db.get('services').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- PLATFORM SETTINGS (e.g. commission rate)
router.get('/settings', requireAuth, requireAdmin, (req, res) => {
  res.json({ settings: db.get('settings').value() });
});

router.patch('/settings', requireAuth, requireAdmin, (req, res) => {
  const { commissionPct } = req.body;
  if (commissionPct === undefined) return res.status(400).json({ error: 'commissionPct is required.' });
  const pct = Number(commissionPct);
  if (isNaN(pct) || pct < 0 || pct > 50) return res.status(400).json({ error: 'Commission must be between 0 and 50%.' });
  db.get('settings').assign({ commissionPct: pct }).write();
  res.json({ ok: true, settings: db.get('settings').value() });
});

// ---------------------------------------------------------------- BLOCKS / SERVICE AREAS MANAGEMENT
router.get('/blocks', requireAuth, requireAdmin, (req, res) => {
  res.json({ blocks: db.get('blocks').value() });
});

router.post('/blocks', requireAuth, requireAdmin, (req, res) => {
  const { name, isHQ } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Block/area name is required.' });
  const existing = db.get('blocks').find(b => b.name.toLowerCase() === name.trim().toLowerCase()).value();
  if (existing) return res.status(409).json({ error: 'This block/area already exists.' });

  const block = { id: 'blk_' + nanoid(8), name: name.trim(), isHQ: !!isHQ, active: true };
  db.get('blocks').push(block).write();
  res.json({ ok: true, block });
});

router.patch('/blocks/:id', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('blocks').find({ id: req.params.id });
  if (!record.value()) return res.status(404).json({ error: 'Block/area not found.' });
  const { name, isHQ, active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (isHQ !== undefined) updates.isHQ = !!isHQ;
  if (active !== undefined) updates.active = !!active;

  if (updates.isHQ === true) {
    // Only one block can be HQ at a time — unset it on everyone else first.
    db.get('blocks').filter(b => b.id !== req.params.id).each(b => { b.isHQ = false; }).write();
  }

  record.assign(updates).write();
  res.json({ ok: true, block: record.value() });
});

router.delete('/blocks/:id', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('blocks').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Block/area not found.' });
  db.get('blocks').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- COUPONS MANAGEMENT
router.get('/coupons', requireAuth, requireAdmin, (req, res) => {
  res.json({ coupons: db.get('coupons').sortBy(c => -c.createdAt || 0).value() });
});

router.post('/coupons', requireAuth, requireAdmin, (req, res) => {
  const { code, type, value, maxDiscount, minOrderValue, usageLimit, expiresAt } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: 'Coupon code is required.' });
  if (!['percent', 'flat'].includes(type)) return res.status(400).json({ error: 'Type must be percent or flat.' });
  if (!value || Number(value) <= 0) return res.status(400).json({ error: 'Enter a valid discount value.' });

  const codeUpper = code.trim().toUpperCase();
  if (db.get('coupons').find(c => c.code === codeUpper).value()) return res.status(409).json({ error: 'A coupon with this code already exists.' });

  const coupon = {
    id: nanoid(), code: codeUpper, type, value: Number(value),
    maxDiscount: maxDiscount ? Number(maxDiscount) : null,
    minOrderValue: minOrderValue ? Number(minOrderValue) : 0,
    usageLimit: usageLimit ? Number(usageLimit) : null,
    usedCount: 0, expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
    active: true, createdAt: Date.now()
  };
  db.get('coupons').push(coupon).write();
  res.json({ ok: true, coupon });
});

router.patch('/coupons/:id', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('coupons').find({ id: req.params.id });
  if (!record.value()) return res.status(404).json({ error: 'Coupon not found.' });
  const { active } = req.body;
  const updates = {};
  if (active !== undefined) updates.active = !!active;
  record.assign(updates).write();
  res.json({ ok: true, coupon: record.value() });
});

router.delete('/coupons/:id', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('coupons').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Coupon not found.' });
  db.get('coupons').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

module.exports = router;
