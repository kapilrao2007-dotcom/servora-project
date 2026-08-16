const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notify } = require('../notify');

const router = express.Router();

// ---------------------------------------------------------------- real disk storage for KYC files
const uploadRoot = path.join(__dirname, '..', 'uploads', 'kyc');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadRoot, req.user.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.fieldname + '-' + Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname).toLowerCase();
    cb(null, safe);
  }
});

const ALLOWED = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED.includes(ext)) return cb(new Error('Only JPG, PNG, WEBP or PDF files are allowed.'));
  cb(null, true);
}

const upload = multer({
  storage, fileFilter,
  limits: { fileSize: 8 * 1024 * 1024, files: 20 } // 8MB per file
});

const kycFields = upload.fields([
  { name: 'aadhaar', maxCount: 1 },
  { name: 'pan', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'certificates', maxCount: 10 },
  { name: 'portfolio', maxCount: 10 },
  { name: 'shopImages', maxCount: 10 }
]);

function relPaths(files) {
  if (!files) return [];
  return files.map(f => path.relative(path.join(__dirname, '..'), f.path).split(path.sep).join('/'));
}

// ---------------------------------------------------------------- REGISTER (real multipart upload)
router.post('/register', requireAuth, (req, res) => {
  kycFields(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const {
      name, mobile, email, address, city, district, village, pincode,
      category, experience, skills, bankAccount, upiId
    } = req.body;

    if (!name || !mobile || !category || !city || !pincode) {
      return res.status(400).json({ error: 'Name, mobile, block/city and pincode are required.' });
    }
    if (!req.files || !req.files.aadhaar || !req.files.pan || !req.files.selfie) {
      return res.status(400).json({ error: 'Aadhaar, PAN and a live selfie are all required for KYC.' });
    }
    if (!bankAccount && !upiId) {
      return res.status(400).json({ error: 'Provide a bank account or a UPI ID for payouts.' });
    }

    const existing = db.get('professionals').find({ userId: req.user.id }).value();
    if (existing) return res.status(409).json({ error: 'You already have a professional profile.', status: existing.status });

    const record = {
      id: nanoid(),
      userId: req.user.id,
      name, mobile, email: email || req.user.email,
      address: address || '', city, district: district || 'Mahendragarh', village: village || '', pincode,
      category, experience: experience || '', skills: skills || '',
      bankAccount: bankAccount || '', upiId: upiId || '',
      aadhaarPath: relPaths(req.files.aadhaar)[0],
      panPath: relPaths(req.files.pan)[0],
      selfiePath: relPaths(req.files.selfie)[0],
      certificatePaths: relPaths(req.files.certificates),
      portfolioPaths: relPaths(req.files.portfolio),
      shopImagePaths: relPaths(req.files.shopImages),
      status: 'pending', // pending -> approved | rejected (by admin)
      isAvailable: true,
      createdAt: Date.now()
    };
    db.get('professionals').push(record).write();
    res.json({ ok: true, status: record.status, id: record.id });
  });
});

// ---------------------------------------------------------------- MY STATUS
router.get('/me', requireAuth, (req, res) => {
  const record = db.get('professionals').find({ userId: req.user.id }).value();
  if (!record) return res.status(404).json({ error: 'No professional profile found.' });
  const { aadhaarPath, panPath, selfiePath, ...safe } = record; // don't leak raw file paths to the client
  res.json({ professional: safe });
});

// ---------------------------------------------------------------- AVAILABILITY TOGGLE
router.patch('/me/availability', requireAuth, (req, res) => {
  const record = db.get('professionals').find({ userId: req.user.id });
  if (!record.value()) return res.status(404).json({ error: 'No professional profile found.' });
  const isAvailable = !!req.body.isAvailable;
  record.assign({ isAvailable }).write();
  res.json({ ok: true, isAvailable });
});

// ---------------------------------------------------------------- EARNINGS SUMMARY
router.get('/me/earnings', requireAuth, (req, res) => {
  const pro = db.get('professionals').find({ userId: req.user.id }).value();
  if (!pro) return res.status(404).json({ error: 'No professional profile found.' });

  const myBookings = db.get('bookings').filter({ professionalId: pro.id }).value();
  const completed = myBookings.filter(b => b.status === 'completed');
  const inProgress = myBookings.filter(b => b.status === 'confirmed_escrow');

  const totalEarned = completed.reduce((a, b) => a + (b.professionalPayout || 0), 0);
  const pendingJobsValue = inProgress.reduce((a, b) => a + (b.professionalPayout || 0), 0);

  const myWithdrawals = db.get('withdrawals').filter({ professionalId: pro.id }).value();
  const totalWithdrawn = myWithdrawals.filter(w => w.status !== 'rejected').reduce((a, w) => a + w.amount, 0);
  const availableBalance = Math.max(0, totalEarned - totalWithdrawn);

  res.json({
    totalEarned, pendingJobsValue, availableBalance,
    completedJobs: completed.length, activeJobs: inProgress.length,
    withdrawals: myWithdrawals.sort((a, b) => b.requestedAt - a.requestedAt)
  });
});

// ---------------------------------------------------------------- REQUEST A WITHDRAWAL
router.post('/me/withdraw', requireAuth, (req, res) => {
  const pro = db.get('professionals').find({ userId: req.user.id }).value();
  if (!pro) return res.status(404).json({ error: 'No professional profile found.' });
  if (!pro.upiId && !pro.bankAccount) return res.status(400).json({ error: 'Add a UPI ID or bank account to your profile before withdrawing.' });

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount.' });

  const myBookings = db.get('bookings').filter({ professionalId: pro.id, status: 'completed' }).value();
  const totalEarned = myBookings.reduce((a, b) => a + (b.professionalPayout || 0), 0);
  const myWithdrawals = db.get('withdrawals').filter({ professionalId: pro.id }).value();
  const totalWithdrawn = myWithdrawals.filter(w => w.status !== 'rejected').reduce((a, w) => a + w.amount, 0);
  const availableBalance = totalEarned - totalWithdrawn;

  if (amount > availableBalance) return res.status(400).json({ error: `You can withdraw up to ₹${availableBalance}.` });

  const record = {
    id: nanoid(), professionalId: pro.id, amount,
    payoutTo: pro.upiId || pro.bankAccount, status: 'pending', requestedAt: Date.now()
  };
  db.get('withdrawals').push(record).write();
  res.json({ ok: true, withdrawal: record });
});

// ---------------------------------------------------------------- MY REVIEWS (professional side)
router.get('/me/reviews', requireAuth, (req, res) => {
  const pro = db.get('professionals').find({ userId: req.user.id }).value();
  if (!pro) return res.status(404).json({ error: 'No professional profile found.' });

  const list = db.get('reviews').filter({ professionalId: pro.id }).sortBy(r => -r.createdAt).value();
  const users = db.get('users').value();
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));
  const enriched = list.map(r => ({ ...r, customerName: userMap[r.userId]?.name || 'Customer' }));
  res.json({ avgRating: pro.avgRating || 0, reviewCount: pro.reviewCount || 0, reviews: enriched });
});

// ---------------------------------------------------------------- ADMIN: list + approve/reject
router.get('/admin/list', requireAuth, requireAdmin, (req, res) => {
  const status = req.query.status;
  let list = db.get('professionals').value();
  if (status) list = list.filter(p => p.status === status);
  res.json({ professionals: list });
});

router.get('/admin/:id/file/:field', requireAuth, requireAdmin, (req, res) => {
  const record = db.get('professionals').find({ id: req.params.id }).value();
  if (!record) return res.status(404).end();
  const map = { aadhaar: record.aadhaarPath, pan: record.panPath, selfie: record.selfiePath };
  const p = map[req.params.field];
  if (!p) return res.status(404).end();
  res.sendFile(path.join(__dirname, '..', p));
});

router.post('/admin/:id/decision', requireAuth, requireAdmin, (req, res) => {
  const { decision } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
  const record = db.get('professionals').find({ id: req.params.id });
  const pro = record.value();
  if (!pro) return res.status(404).json({ error: 'Not found.' });
  record.assign({ status: decision, decidedAt: Date.now() }).write();
  notify(pro.userId, decision === 'approved' ? 'kyc_approved' : 'kyc_rejected',
    decision === 'approved' ? 'You\'re approved!' : 'Application not approved',
    decision === 'approved' ? 'Your professional profile is live — head to your dashboard to start accepting jobs.' : 'Your KYC application wasn\'t approved. Contact support for details.',
    '/#/pro-dashboard');
  res.json({ ok: true });
});

module.exports = router;
