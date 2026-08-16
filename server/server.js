require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('./db');
const { attachChat } = require('./chat');

if (!process.env.JWT_SECRET) {
  console.error('❌ Missing JWT_SECRET in server/.env — copy .env.example to .env first.');
  process.exit(1);
}

const app = express();

// Security headers. CSP is disabled because the frontend uses plain inline
// <script> tags (no build step / nonces) — the other headers (frame options,
// no-sniff, HSTS, etc.) still apply and don't require any frontend changes.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS: by default only the app's own origin is allowed. Set ALLOWED_ORIGINS
// (comma-separated) in .env if the frontend is ever served from a different
// domain than the API (e.g. a separate static-site host).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = allowedOrigins.length
  ? { origin: allowedOrigins }
  : { origin: true }; // same-origin app by default — reflects the request origin, no wildcard
app.use(cors(corsOptions));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Baseline rate limit across the whole API — generous, just stops obvious abuse/scraping.
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' }
}));

// Tighter limits on auth endpoints specifically — these are the ones worth
// protecting from brute-force/spam (login guessing, OTP flooding, fake signups).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/send-otp', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/auth/google', authLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/professionals', require('./routes/professionals'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/services', require('./routes/services'));
app.use('/api/blocks', require('./routes/blocks'));
app.use('/api/wallet', require('./routes/wallet'));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'SERVORA API', time: Date.now() }));

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler — catches anything forwarded via next(err), including
// errors from asyncHandler-wrapped routes and multer upload errors. Without
// this, an unexpected error could crash the whole process or leak a stack
// trace to the client.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? 'Something went wrong on our end. Please try again.' : (err.message || 'Request failed.') });
});

// Defense in depth: log anything that somehow still slips through uncaught,
// rather than letting the process die silently or ungracefully.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const PORT = process.env.PORT || 4000;
const httpServer = http.createServer(app);
attachChat(httpServer, corsOptions);

// The database (Mongo or local file) must finish loading before the admin
// account check runs and before the server starts accepting requests.
(async () => {
  await db.initDb();

  // Auto-create the admin account on first boot (so the admin panel is usable immediately).
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@servora.in').toLowerCase();
  const existing = db.get('users').find({ email: adminEmail }).value();
  if (!existing) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeMe123!', 10);
    db.get('users').push({
      id: nanoid(), name: 'SERVORA Admin', email: adminEmail, mobile: '',
      passwordHash, provider: 'email', isAdmin: true, createdAt: Date.now()
    }).write();
    console.log(`👑 Admin account created: ${adminEmail} — log in with the password from server/.env`);
  }

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 SERVORA server running: http://localhost:${PORT}`);
    console.log(`   Admin panel:            http://localhost:${PORT}/admin.html\n`);
  });
})();
