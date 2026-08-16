const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { OAuth2Client } = require('google-auth-library');
const { asyncHandler } = require('../utils/asyncHandler');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
const isMobile = v => /^[6-9]\d{9}$/.test(v || '');

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, mobile: u.mobile, provider: u.provider, referralCode: u.referralCode };
}

function generateReferralCode(name) {
  const prefix = (name || 'USER').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase().padEnd(4, 'X');
  let code;
  do {
    code = prefix + Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (db.get('users').find({ referralCode: code }).value());
  return code;
}

// ---------------------------------------------------------------- SIGNUP
router.post('/signup', asyncHandler(async (req, res) => {
  const { name, email, mobile, password, referralCode } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Enter your full name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!isMobile(mobile)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const emailLower = email.trim().toLowerCase();
  if (db.get('users').find({ email: emailLower }).value()) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  if (db.get('users').find({ mobile }).value()) {
    return res.status(409).json({ error: 'An account with this mobile number already exists.' });
  }

  const referrer = referralCode ? db.get('users').find({ referralCode: referralCode.trim().toUpperCase() }).value() : null;

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: nanoid(), name: name.trim(), email: emailLower, mobile,
    passwordHash, provider: 'email', createdAt: Date.now(),
    referralCode: generateReferralCode(name), referredBy: referrer ? referrer.id : null
  };
  db.get('users').push(user).write();
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// ---------------------------------------------------------------- LOGIN (email + password)
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!isEmail(email) || !password) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const user = db.get('users').find({ email: email.trim().toLowerCase() }).value();
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'No account found with this email.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// ---------------------------------------------------------------- SEND OTP (real Twilio if configured)
router.post('/send-otp', asyncHandler(async (req, res) => {
  const { mobile, purpose } = req.body; // purpose: 'login' | 'signup'
  if (!isMobile(mobile)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });

  if (purpose === 'login') {
    const existing = db.get('users').find({ mobile }).value();
    if (!existing) return res.status(404).json({ error: 'No account found with this number. Please sign up first.' });
  }
  if (purpose === 'signup') {
    const existing = db.get('users').find({ mobile }).value();
    if (existing) return res.status(409).json({ error: 'An account with this number already exists. Please log in.' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.get('otps').push({
    id: nanoid(), target: mobile, code, purpose,
    expiresAt: Date.now() + 5 * 60 * 1000, used: false
  }).write();

  let delivered = false;

  // 2Factor.in — purpose-built for OTP delivery to Indian numbers, no DLT
  // registration or number purchase needed on your end (their OTP template
  // is already carrier-approved). Preferred for India if configured.
  if (!delivered && process.env.TWO_FACTOR_API_KEY) {
    try {
      const resp = await fetch(`https://2factor.in/API/V1/${process.env.TWO_FACTOR_API_KEY}/SMS/${mobile}/${code}/${process.env.TWO_FACTOR_TEMPLATE || 'OTP1'}`);
      const data = await resp.json();
      if (data.Status === 'Success') delivered = true;
      else console.error('2Factor send failed:', data.Details || data);
    } catch (e) {
      console.error('2Factor request failed, falling back:', e.message);
    }
  }

  // Twilio — works globally, but SMS to Indian numbers from a non-Indian
  // sender ID can be filtered by carriers unless you've done DLT registration.
  if (!delivered && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `Your SERVORA verification code is ${code}. It expires in 5 minutes.`,
        from: process.env.TWILIO_FROM_NUMBER,
        to: '+91' + mobile
      });
      delivered = true;
    } catch (e) {
      console.error('Twilio send failed, falling back to dev mode:', e.message);
    }
  }

  console.log(`[OTP] ${mobile} (${purpose}) -> ${code}`);
  res.json({
    ok: true,
    delivered,
    message: delivered
      ? 'OTP sent to your mobile via SMS.'
      : 'DEV MODE: no SMS provider configured, so nothing was texted. Code is included below and logged on the server console.',
    devCode: delivered ? undefined : code
  });
}));

// ---------------------------------------------------------------- VERIFY OTP
router.post('/verify-otp', (req, res) => {
  const { mobile, code, purpose, name, email } = req.body;
  const candidates = db.get('otps').filter({ target: mobile, purpose, used: false }).value();
  const latest = candidates[candidates.length - 1];

  if (!latest) return res.status(400).json({ error: 'No OTP request found. Please request a new code.' });
  if (Date.now() > latest.expiresAt) return res.status(400).json({ error: 'This OTP has expired. Request a new one.' });
  if (latest.code !== code) return res.status(400).json({ error: 'Incorrect OTP.' });

  db.get('otps').find({ id: latest.id }).assign({ used: true }).write();

  if (purpose === 'login') {
    const user = db.get('users').find({ mobile }).value();
    if (!user) return res.status(404).json({ error: 'No account found.' });
    return res.json({ token: signToken(user), user: publicUser(user) });
  }

  // signup via OTP
  if (!name || !isEmail(email)) return res.status(400).json({ error: 'Name and valid email are required to finish signup.' });
  const emailLower = email.trim().toLowerCase();
  if (db.get('users').find({ email: emailLower }).value()) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  const user = {
    id: nanoid(), name: name.trim(), email: emailLower, mobile,
    passwordHash: null, provider: 'mobile', createdAt: Date.now(),
    referralCode: generateReferralCode(name),
    referredBy: (req.body.referralCode ? db.get('users').find({ referralCode: req.body.referralCode.trim().toUpperCase() }).value() : null)?.id || null
  };
  db.get('users').push(user).write();
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---------------------------------------------------------------- GOOGLE SIGN-IN (real ID token verification)
router.post('/google', asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (!process.env.GOOGLE_CLIENT_ID || !googleClient) {
    return res.status(503).json({
      error: 'Google Sign-In is not configured on this server yet. Add GOOGLE_CLIENT_ID to server/.env — see README.'
    });
  }
  if (!idToken) return res.status(400).json({ error: 'Missing Google credential.' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    let user = db.get('users').find({ email }).value();
    if (!user) {
      user = {
        id: nanoid(), name: payload.name || email.split('@')[0], email,
        mobile: '', passwordHash: null, provider: 'google', createdAt: Date.now(),
        referralCode: generateReferralCode(payload.name), referredBy: null
      };
      db.get('users').push(user).write();
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(401).json({ error: 'Could not verify Google sign-in. Please try again.' });
  }
}));

// ---------------------------------------------------------------- ME
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------------------------------------------------------------- MY REFERRALS
router.get('/me/referrals', requireAuth, (req, res) => {
  const referrals = db.get('referrals').filter({ referrerUserId: req.user.id }).sortBy(r => -r.createdAt).value();
  const totalEarned = referrals.filter(r => r.status === 'rewarded').reduce((a, r) => a + r.rewardAmount, 0);
  res.json({ referralCode: req.user.referralCode, referralCount: referrals.length, totalEarned, referrals });
});

module.exports = router;
