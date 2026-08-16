const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const Razorpay = require('razorpay');
const { asyncHandler } = require('../utils/asyncHandler');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { notify } = require('../notify');

const router = express.Router();

const razorpayLive = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const rzp = razorpayLive
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

function getWallet(userId) {
  let w = db.get('wallets').find({ userId }).value();
  if (!w) { w = { userId, balance: 0, txns: [] }; db.get('wallets').push(w).write(); }
  return w;
}

// Validates a coupon code against an order value. Returns { discount, coupon } or { error }.
function evaluateCoupon(code, orderValue) {
  const coupon = db.get('coupons').find(c => c.code.toUpperCase() === (code || '').trim().toUpperCase()).value();
  if (!coupon) return { error: 'Invalid coupon code.' };
  if (!coupon.active) return { error: 'This coupon is no longer active.' };
  if (coupon.expiresAt && Date.now() > coupon.expiresAt) return { error: 'This coupon has expired.' };
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return { error: 'This coupon has reached its usage limit.' };
  if (coupon.minOrderValue && orderValue < coupon.minOrderValue) return { error: `This coupon requires a minimum order of ₹${coupon.minOrderValue}.` };

  let discount = coupon.type === 'percent' ? Math.round(orderValue * coupon.value / 100) : coupon.value;
  if (coupon.type === 'percent' && coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(discount, orderValue - 1); // never let a coupon drop the price to ₹0
  return { discount, coupon };
}

// ---------------------------------------------------------------- PREVIEW A COUPON (before creating the booking)
router.post('/coupon-preview', requireAuth, (req, res) => {
  const { code, orderValue } = req.body;
  const result = evaluateCoupon(code, Number(orderValue));
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, discount: result.discount, finalPrice: Number(orderValue) - result.discount });
});

// ---------------------------------------------------------------- CREATE BOOKING + RAZORPAY ORDER
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { service, date, time, address, couponCode, useWallet } = req.body;
  if (!service || !date || !time || !address) {
    return res.status(400).json({ error: 'Service, date, time and address are all required.' });
  }

  // SECURITY: never trust a client-supplied price. Always look up the
  // canonical price for this service from the database. Without this check,
  // anyone could tamper with the request and pay any amount they choose.
  const canonicalService = db.get('services').find({ name: service, active: true }).value();
  if (!canonicalService) {
    return res.status(400).json({ error: 'This service is not currently available.' });
  }

  let finalPrice = canonicalService.price;
  let discountAmount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    const result = evaluateCoupon(couponCode, finalPrice);
    if (result.error) return res.status(400).json({ error: result.error });
    discountAmount = result.discount;
    finalPrice = finalPrice - discountAmount;
    appliedCoupon = result.coupon.code;
  }

  let walletUsed = 0;
  if (useWallet) {
    const wallet = getWallet(req.user.id);
    walletUsed = Math.min(wallet.balance || 0, finalPrice - 1); // never let it drop to ₹0
    if (walletUsed > 0) {
      finalPrice -= walletUsed;
      db.get('wallets').find({ userId: req.user.id }).assign({
        balance: (wallet.balance || 0) - walletUsed,
        txns: [{ type: 'debit', amount: walletUsed, label: 'Applied to ' + service + ' booking', date: Date.now() }, ...wallet.txns]
      }).write();
    }
  }

  const amountPaise = Math.round(finalPrice * 100);
  if (!amountPaise || amountPaise < 100) return res.status(400).json({ error: 'Invalid amount.' });

  const bookingId = nanoid();

  if (razorpayLive) {
    try {
      const order = await rzp.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: bookingId,
        notes: { service, userId: req.user.id }
      });
      const booking = {
        id: bookingId, userId: req.user.id, service, price: finalPrice, originalPrice: canonicalService.price,
        couponCode: appliedCoupon, discountAmount, walletUsed, date, time, address,
        razorpayOrderId: order.id, razorpayPaymentId: null, status: 'awaiting_payment', createdAt: Date.now(),
        professionalId: null, rejectedBy: []
      };
      db.get('bookings').push(booking).write();
      return res.json({ ok: true, bookingId, razorpay: { orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID, live: true } });
    } catch (e) {
      console.error('Razorpay order creation failed:', e);
      return res.status(502).json({ error: 'Could not create a payment order. Please try again.' });
    }
  }

  // DEV MODE fallback — no Razorpay keys configured yet.
  const mockOrderId = 'order_DEV_' + nanoid(10);
  const booking = {
    id: bookingId, userId: req.user.id, service, price: finalPrice, originalPrice: canonicalService.price,
    couponCode: appliedCoupon, discountAmount, walletUsed, date, time, address,
    razorpayOrderId: mockOrderId, razorpayPaymentId: null, status: 'awaiting_payment', createdAt: Date.now(),
    professionalId: null, rejectedBy: []
  };
  db.get('bookings').push(booking).write();
  res.json({ ok: true, bookingId, razorpay: { orderId: mockOrderId, amount: amountPaise, currency: 'INR', keyId: null, live: false } });
}));

// ---------------------------------------------------------------- VERIFY PAYMENT (real HMAC signature check)
router.post('/verify-payment', requireAuth, (req, res) => {
  const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const booking = db.get('bookings').find({ id: bookingId, userId: req.user.id });
  const record = booking.value();
  if (!record) return res.status(404).json({ error: 'Booking not found.' });

  if (razorpayLive) {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment confirmation details.' });
    }
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
    if (expected !== razorpay_signature) {
      if (record.walletUsed > 0) {
        const w = getWallet(req.user.id);
        db.get('wallets').find({ userId: req.user.id }).assign({
          balance: (w.balance || 0) + record.walletUsed,
          txns: [{ type: 'credit', amount: record.walletUsed, label: 'Refunded — payment failed', date: Date.now() }, ...w.txns]
        }).write();
      }
      booking.assign({ status: 'payment_failed' }).write();
      return res.status(400).json({ error: 'Payment verification failed. This payment was not confirmed as genuine.' });
    }
  }
  // DEV MODE (no live keys): trust the client-reported success since no real gateway is attached yet.

  const platformCommissionPct = (db.get('settings').value() || {}).commissionPct ?? 15;
  const commission = Math.round(record.price * platformCommissionPct) / 100;
  booking.assign({
    status: 'confirmed_escrow',
    razorpayPaymentId: razorpay_payment_id || 'DEV_PAYMENT_' + Date.now(),
    commission,
    professionalPayout: record.price - commission
  }).write();

  const wallet = getWallet(req.user.id);
  db.get('wallets').find({ userId: req.user.id }).assign({
    txns: [{ type: 'debit', amount: record.price, label: record.service + ' booking', bookingId: record.id, date: Date.now() }, ...wallet.txns]
  }).write();

  if (record.couponCode) {
    const coupon = db.get('coupons').find(c => c.code.toUpperCase() === record.couponCode.toUpperCase());
    if (coupon.value()) coupon.assign({ usedCount: (coupon.value().usedCount || 0) + 1 }).write();
  }

  res.json({ ok: true, booking: booking.value() });
});

// ---------------------------------------------------------------- MY BOOKINGS (customer side)
router.get('/mine', requireAuth, (req, res) => {
  const list = db.get('bookings').filter({ userId: req.user.id }).sortBy(b => -b.createdAt).value();
  res.json({ bookings: list });
});

function getMyProfessionalProfile(userId) {
  return db.get('professionals').find({ userId }).value();
}

// ---------------------------------------------------------------- AVAILABLE JOB REQUESTS (professional side)
// Shows paid bookings in this professional's category that haven't been
// accepted yet, and that this professional hasn't already rejected.
router.get('/available', requireAuth, (req, res) => {
  const pro = getMyProfessionalProfile(req.user.id);
  if (!pro) return res.status(403).json({ error: 'No professional profile found.' });
  if (pro.status !== 'approved') return res.status(403).json({ error: 'Your professional account is not approved yet.' });

  const list = db.get('bookings')
    .filter(b => b.status === 'confirmed_escrow' && !b.professionalId && b.service === pro.category && !(b.rejectedBy || []).includes(pro.id))
    .sortBy(b => -b.createdAt)
    .value();

  const users = db.get('users').value();
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  const enriched = list.map(b => ({ ...b, customerName: userMap[b.userId]?.name || 'Customer', customerMobile: userMap[b.userId]?.mobile || '' }));
  res.json({ jobs: enriched });
});

// ---------------------------------------------------------------- MY ACCEPTED JOBS (professional side)
router.get('/my-jobs', requireAuth, (req, res) => {
  const pro = getMyProfessionalProfile(req.user.id);
  if (!pro) return res.status(403).json({ error: 'No professional profile found.' });

  const list = db.get('bookings').filter({ professionalId: pro.id }).sortBy(b => -b.createdAt).value();
  const users = db.get('users').value();
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  const enriched = list.map(b => ({ ...b, customerName: userMap[b.userId]?.name || 'Customer', customerMobile: userMap[b.userId]?.mobile || '' }));
  res.json({ jobs: enriched });
});

// ---------------------------------------------------------------- ACCEPT a job request
router.post('/:id/accept', requireAuth, (req, res) => {
  const pro = getMyProfessionalProfile(req.user.id);
  if (!pro) return res.status(403).json({ error: 'No professional profile found.' });
  if (pro.status !== 'approved') return res.status(403).json({ error: 'Your professional account is not approved yet.' });

  const booking = db.get('bookings').find({ id: req.params.id });
  const record = booking.value();
  if (!record) return res.status(404).json({ error: 'Job not found.' });
  if (record.professionalId) return res.status(409).json({ error: 'This job has already been accepted by another professional.' });
  if (record.status !== 'confirmed_escrow') return res.status(400).json({ error: 'This job is not available to accept.' });
  if (record.service !== pro.category) return res.status(403).json({ error: 'This job is outside your registered category.' });

  booking.assign({ professionalId: pro.id, assignedAt: Date.now() }).write();
  notify(record.userId, 'job_accepted', 'Professional assigned', `${pro.name} accepted your ${record.service} booking and will arrive at your scheduled time.`, '/#/dashboard');
  res.json({ ok: true, booking: booking.value() });
});

// ---------------------------------------------------------------- REJECT a job request (just hides it from this professional)
router.post('/:id/reject', requireAuth, (req, res) => {
  const pro = getMyProfessionalProfile(req.user.id);
  if (!pro) return res.status(403).json({ error: 'No professional profile found.' });

  const booking = db.get('bookings').find({ id: req.params.id });
  const record = booking.value();
  if (!record) return res.status(404).json({ error: 'Job not found.' });

  const rejectedBy = record.rejectedBy || [];
  if (!rejectedBy.includes(pro.id)) rejectedBy.push(pro.id);
  booking.assign({ rejectedBy }).write();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- MARK COMPLETE -> release escrow
// Either the customer or the assigned professional can mark a job complete.
router.post('/:id/complete', requireAuth, (req, res) => {
  const booking = db.get('bookings').find({ id: req.params.id });
  const record = booking.value();
  if (!record) return res.status(404).json({ error: 'Booking not found.' });

  const pro = getMyProfessionalProfile(req.user.id);
  const isCustomer = record.userId === req.user.id;
  const isAssignedProfessional = pro && record.professionalId === pro.id;
  if (!isCustomer && !isAssignedProfessional) return res.status(403).json({ error: 'You are not part of this booking.' });

  if (record.status !== 'confirmed_escrow') return res.status(400).json({ error: 'Only escrowed bookings can be marked complete.' });
  booking.assign({ status: 'completed', completedAt: Date.now(), completedBy: isCustomer ? 'customer' : 'professional' }).write();

  const assignedPro = record.professionalId ? db.get('professionals').find({ id: record.professionalId }).value() : null;
  if (isCustomer && assignedPro) {
    notify(assignedPro.userId, 'job_completed', 'Job marked complete', `Your ${record.service} job has been marked complete. Payout added to your earnings.`, '/#/pro-dashboard');
  } else if (isAssignedProfessional) {
    notify(record.userId, 'job_completed', 'Job marked complete', `Your ${record.service} booking is complete. Leave a review to help other customers!`, '/#/dashboard');
  }

  // Reward the referrer + referee the first time the referred customer completes a job.
  const customer = db.get('users').find({ id: record.userId }).value();
  if (customer && customer.referredBy) {
    const alreadyRewarded = db.get('referrals').find({ refereeUserId: customer.id }).value();
    const otherCompletedJobs = db.get('bookings').filter(b => b.userId === customer.id && b.status === 'completed' && b.id !== record.id).value();
    if (!alreadyRewarded && otherCompletedJobs.length === 0) {
      const REFERRAL_REWARD = 50;
      [customer.referredBy, customer.id].forEach(uid => {
        const wallet = getWallet(uid);
        db.get('wallets').find({ userId: uid }).assign({
          balance: (wallet.balance || 0) + REFERRAL_REWARD,
          txns: [{ type: 'credit', amount: REFERRAL_REWARD, label: 'Referral reward', date: Date.now() }, ...wallet.txns]
        }).write();
      });
      db.get('referrals').push({
        id: nanoid(), referrerUserId: customer.referredBy, refereeUserId: customer.id,
        rewardAmount: REFERRAL_REWARD, status: 'rewarded', createdAt: Date.now()
      }).write();
      notify(customer.referredBy, 'referral_reward', 'Referral reward earned!', `Someone you referred completed their first booking — ₹${REFERRAL_REWARD} added to your wallet.`, '/#/dashboard');
      notify(customer.id, 'referral_reward', 'Welcome bonus earned!', `₹${REFERRAL_REWARD} added to your wallet for completing your first booking.`, '/#/dashboard');
    }
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------- CANCEL BOOKING (before completion) — real Razorpay refund
router.post('/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  const booking = db.get('bookings').find({ id: req.params.id, userId: req.user.id });
  const record = booking.value();
  if (!record) return res.status(404).json({ error: 'Booking not found.' });

  if (record.status === 'awaiting_payment') {
    if (record.walletUsed > 0) {
      const wallet = getWallet(req.user.id);
      db.get('wallets').find({ userId: req.user.id }).assign({
        balance: (wallet.balance || 0) + record.walletUsed,
        txns: [{ type: 'credit', amount: record.walletUsed, label: 'Refunded — booking cancelled before payment', date: Date.now() }, ...wallet.txns]
      }).write();
    }
    booking.assign({ status: 'cancelled', cancelledAt: Date.now(), cancelReason: req.body.reason || 'Cancelled before payment' }).write();
    return res.json({ ok: true, refunded: false, message: 'Booking cancelled. No payment had been made.' });
  }
  if (record.status !== 'confirmed_escrow') {
    return res.status(400).json({ error: 'This booking can no longer be cancelled directly — use "Request Refund" instead.' });
  }

  let refundId = null, refundStatus = 'dev_mode';
  const isDevPayment = !record.razorpayPaymentId || record.razorpayPaymentId.startsWith('DEV_');

  if (razorpayLive && !isDevPayment) {
    try {
      const refund = await rzp.payments.refund(record.razorpayPaymentId, {
        amount: Math.round(record.price * 100),
        speed: 'normal',
        notes: { reason: req.body.reason || 'Customer cancelled', bookingId: record.id }
      });
      refundId = refund.id;
      refundStatus = refund.status; // 'pending' | 'processed'
    } catch (e) {
      console.error('Razorpay refund failed:', e);
      return res.status(502).json({ error: 'Could not process the refund with Razorpay. Please contact support.' });
    }
  }

  booking.assign({
    status: 'cancelled', cancelledAt: Date.now(), cancelReason: req.body.reason || 'Cancelled by customer',
    refundId, refundStatus
  }).write();

  if (record.professionalId) {
    const assignedPro = db.get('professionals').find({ id: record.professionalId }).value();
    if (assignedPro) notify(assignedPro.userId, 'job_cancelled', 'Booking cancelled', `The customer cancelled the ${record.service} job you had accepted.`, '/#/pro-dashboard');
  }

  res.json({ ok: true, refunded: true, refundStatus, message: razorpayLive && !isDevPayment ? 'Refund initiated with Razorpay — it will reflect in 5–7 business days.' : 'Refund marked (dev mode — no live payment to actually refund).' });
}));

// ---------------------------------------------------------------- REQUEST A REFUND on a completed booking (goes to admin review)
router.post('/:id/refund-request', requireAuth, (req, res) => {
  const record = db.get('bookings').find({ id: req.params.id, userId: req.user.id }).value();
  if (!record) return res.status(404).json({ error: 'Booking not found.' });
  if (record.status !== 'completed') return res.status(400).json({ error: 'Refund requests can only be raised on completed bookings.' });

  const existing = db.get('refundRequests').find({ bookingId: record.id, status: 'pending' }).value();
  if (existing) return res.status(409).json({ error: 'A refund request for this booking is already pending review.' });

  const reason = (req.body.reason || '').trim();
  if (reason.length < 10) return res.status(400).json({ error: 'Please describe the issue in at least 10 characters.' });

  const request = {
    id: nanoid(), bookingId: record.id, userId: req.user.id, amount: record.price,
    reason, status: 'pending', requestedAt: Date.now()
  };
  db.get('refundRequests').push(request).write();
  res.json({ ok: true, request });
});

// ---------------------------------------------------------------- SUBMIT A REVIEW (only for completed, assigned bookings)
router.post('/:id/review', requireAuth, (req, res) => {
  const record = db.get('bookings').find({ id: req.params.id, userId: req.user.id }).value();
  if (!record) return res.status(404).json({ error: 'Booking not found.' });
  if (record.status !== 'completed') return res.status(400).json({ error: 'You can only review a completed booking.' });
  if (!record.professionalId) return res.status(400).json({ error: 'This booking has no assigned professional to review.' });

  const existing = db.get('reviews').find({ bookingId: record.id }).value();
  if (existing) return res.status(409).json({ error: 'You already reviewed this booking.' });

  const rating = Number(req.body.rating);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  const comment = (req.body.comment || '').slice(0, 500).trim();

  const review = {
    id: nanoid(), bookingId: record.id, userId: req.user.id, professionalId: record.professionalId,
    rating, comment, createdAt: Date.now()
  };
  db.get('reviews').push(review).write();

  // Recompute the professional's aggregate rating.
  const allReviews = db.get('reviews').filter({ professionalId: record.professionalId }).value();
  const avgRating = Math.round((allReviews.reduce((a, r) => a + r.rating, 0) / allReviews.length) * 10) / 10;
  db.get('professionals').find({ id: record.professionalId }).assign({ avgRating, reviewCount: allReviews.length }).write();

  const assignedPro = db.get('professionals').find({ id: record.professionalId }).value();
  if (assignedPro) notify(assignedPro.userId, 'new_review', 'New review received', `You got a ${rating}-star review for ${record.service}.`, '/#/pro-dashboard');

  res.json({ ok: true, review });
});

// ---------------------------------------------------------------- CHAT: list messages for a booking
router.get('/:id/messages', requireAuth, (req, res) => {
  const record = db.get('bookings').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Booking not found.' });

  const pro = getMyProfessionalProfile(req.user.id);
  const isCustomer = record.userId === req.user.id;
  const isAssignedProfessional = pro && record.professionalId === pro.id;
  if (!isCustomer && !isAssignedProfessional) return res.status(403).json({ error: 'You are not part of this booking.' });
  if (!record.professionalId) return res.status(400).json({ error: 'Chat opens once a professional accepts this job.' });

  const messages = db.get('messages').filter({ bookingId: record.id }).sortBy(m => m.createdAt).value();
  res.json({ messages });
});

// ---------------------------------------------------------------- CHAT: send a message
router.post('/:id/messages', requireAuth, (req, res) => {
  const record = db.get('bookings').find({ id: req.params.id }).value();
  if (!record) return res.status(404).json({ error: 'Booking not found.' });

  const pro = getMyProfessionalProfile(req.user.id);
  const isCustomer = record.userId === req.user.id;
  const isAssignedProfessional = pro && record.professionalId === pro.id;
  if (!isCustomer && !isAssignedProfessional) return res.status(403).json({ error: 'You are not part of this booking.' });
  if (!record.professionalId) return res.status(400).json({ error: 'Chat opens once a professional accepts this job.' });
  if (['cancelled', 'refunded'].includes(record.status)) return res.status(400).json({ error: 'This booking is closed — chat is no longer available.' });

  const text = (req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Message cannot be empty.' });

  const message = {
    id: nanoid(), bookingId: record.id, senderId: req.user.id,
    senderRole: isCustomer ? 'customer' : 'professional', text, createdAt: Date.now()
  };
  db.get('messages').push(message).write();

  const recipientUserId = isCustomer ? db.get('professionals').find({ id: record.professionalId }).value()?.userId : record.userId;
  if (recipientUserId) {
    notify(recipientUserId, 'new_message', 'New message', `${isCustomer ? 'Customer' : 'Professional'} sent a message about your ${record.service} booking.`, isCustomer ? '/#/pro-dashboard' : '/#/dashboard');
  }

  res.json({ ok: true, message });
});

module.exports = router;
