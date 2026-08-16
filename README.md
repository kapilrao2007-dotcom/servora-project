# SERVORA — Full Project (Real Backend)

Scoped to launch first across **Mahendragarh district, Haryana** — all 8 blocks (Narnaul, Mahendragarh, Kanina, Ateli, Nangal Chaudhary, Nizampur, Sihma, Satnali), covering the district's 5 major towns and 372 villages — before expanding to the rest of Haryana.

This is a real, running full-stack version of SERVORA:

- **Real authentication** — passwords hashed with bcrypt, sessions are real JWTs, wrong email/password is actually rejected.
- **Real mobile OTP flow** — codes are generated and expire server-side; wired for real SMS delivery via Twilio (optional).
- **Real Google Sign-In** — verifies the actual Google ID token server-side (optional, needs a free Google Cloud OAuth client).
- **Real KYC file uploads** — Aadhaar, PAN, selfie, certificates, portfolio and shop photos are uploaded as real files and saved to disk under `server/uploads/kyc/<userId>/`, linked to the professional's record.
- **Real job assignment** — paid bookings are matched to approved professionals by category; professionals see them as job requests, first to accept gets the job, others see it disappear.
- **Professional Dashboard** (`/pro-dashboard` for logged-in professionals) — job requests, accepted jobs with "Navigate" (opens Google Maps) and "Mark Complete", earnings summary, and withdrawal requests.
- **Cancel & Refund** — customers can cancel unpaid or paid-but-not-yet-completed bookings (real Razorpay refund if live keys are set); for completed jobs, they raise a refund request that an admin reviews and approves/rejects from the admin panel.
- **Ratings & Reviews** — customers rate completed jobs (1–5 stars + comment); a professional's average rating updates automatically. Real reviews appear on the homepage and in the professional's own dashboard, replacing the placeholder testimonials once any exist.
- **Notifications** — a polling-based (every 15s) notification bell in the navbar. Real events trigger real notifications: KYC approved/rejected, job accepted, job completed, booking cancelled, new review received, refund approved/rejected, withdrawal paid/rejected.
- **Admin-managed Services & Commission** — services shown on the site (name, price, description, category) are now stored in the database and editable from the admin panel's "Services" tab — no code changes needed to add/edit/remove a service. The platform commission percentage is also configurable from the "Settings" tab and applies to all new bookings going forward.
- **Admin-managed Service Areas** — the blocks/areas shown on the homepage coverage map and in the professional registration form are now editable from the admin panel's "Areas" tab. Expanding to a new district (e.g. Rewari, Bhiwani) is now a matter of adding an area from the admin panel, not editing code.
- **Coupons & Referral Rewards** — customers can apply a coupon code at checkout (flat or percent discount, admin-managed from the "Coupons" tab). Every user gets a shareable referral link; when someone they refer completes their first booking, both people get ₹50 credited to their real wallet. Wallet balance can also be applied toward a future booking's total.
- **Production-ready database** — set `MONGODB_URI` in `server/.env` (free tier on MongoDB Atlas works) and all data survives restarts and redeploys. Without it, the app still runs great locally using a JSON file, exactly as before — nothing else changes either way.
- **In-app chat** — once a professional accepts a job, the customer and professional can message each other about that booking (polling-based, updates every 5s — no separate real-time server needed). Access is locked to the two people on that booking; the other party gets a notification when a new message arrives.
- **Coupons** — admins create percent/flat discount codes (min order value, usage limit, expiry) from the "Coupons" tab; customers apply them at checkout for a real price reduction.
- **Referral Rewards** — every user gets a unique referral code (visible in Dashboard → Refer & Earn). When someone signs up with it and completes their first booking, both people get ₹50 credited to their wallet.
- **Wallet** — tracks real balance and transaction history (referral rewards, refunds credited here). Customers can apply their wallet balance toward a booking's total at checkout, combined with any coupon discount.
- **Real payments** — creates a real Razorpay order and verifies the payment signature server-side (optional, needs a free Razorpay test account). Without keys, a clearly-labelled dev-mode flow lets you test the full booking journey.
- **Admin panel** (`/admin.html`) — review pending professionals, preview their uploaded documents, approve or reject.

## What "real" means here, honestly

Everything above runs on genuine server logic — nothing is faked in the code. The only things that need *you* to add credentials are the three services that legally require a registered account in your name: **Razorpay** (to move real money), **Twilio** (to send real SMS), and **Google Cloud** (to issue real Google logins). All three have a free tier and take a few minutes to set up. Until you add them, the app runs in a clearly labelled "dev mode" for that one feature — everything else (accounts, passwords, KYC uploads, bookings, escrow math, admin approvals) is fully real and working today.

---

## 1. Install & run

Requires [Node.js 18+](https://nodejs.org).

```bash
cd server
npm install
cp .env.example .env
```

Open `server/.env` and set at least:
```
JWT_SECRET=any-long-random-string
ADMIN_EMAIL=admin@servora.in
ADMIN_PASSWORD=pick-a-real-password
```

Then start it:
```bash
npm start
```

Visit:
- **Website:** http://localhost:4000
- **Admin panel:** http://localhost:4000/admin.html (log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`)

That's it — signup, login, OTP, KYC upload and bookings all work immediately in dev mode, no external accounts needed.

---

## 2. Going fully live (optional, per feature)

### Real UPI/card payments — Razorpay
1. Create a free account at https://dashboard.razorpay.com/signup
2. Copy your **Test Mode** Key ID and Key Secret from Settings → API Keys
3. Paste into `server/.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
   ```
4. Restart the server. The booking flow now opens the real Razorpay Checkout widget. Use Razorpay's [test card/UPI numbers](https://razorpay.com/docs/payments/payments/test-card-upi-details/) to simulate a real payment end-to-end.
5. To accept real money from real customers, switch to **Live Mode** keys — Razorpay will ask for your business KYC directly (this is Razorpay's compliance step, not something this app can do for you).

### Real SMS OTP — 2Factor.in (recommended for India)
1. Sign up free at https://2factor.in/v3/signup/ — no phone number purchase, no DLT registration needed on your end.
2. Copy your **API Key** from the 2Factor dashboard.
3. Paste into `server/.env`:
   ```
   TWO_FACTOR_API_KEY=your-api-key-here
   ```
4. Restart the server. OTPs now arrive as real SMS on Indian numbers.

### Real SMS OTP — Twilio (alternative, works globally)
1. Create a free trial account at https://www.twilio.com/try-twilio
2. Get a phone number and your Account SID / Auth Token
3. Paste into `server/.env`:
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxx
   TWILIO_FROM_NUMBER=+1xxxxxxxxxx
   ```
4. Restart the server. Note: Twilio's Indian (+91) numbers need regulatory approval that can take days, and non-Indian sender numbers can get filtered by Indian carriers without DLT registration — 2Factor above avoids both issues.

### Real Google Sign-In
1. Go to https://console.cloud.google.com/apis/credentials
2. Create an **OAuth 2.0 Client ID** → Application type: *Web application*
3. Add `http://localhost:4000` (and your real domain later) under *Authorized JavaScript origins*
4. Copy the Client ID into **two** places:
   - `server/.env` → `GOOGLE_CLIENT_ID=...`
   - `public/config.js` → `window.SERVORA_GOOGLE_CLIENT_ID = '...'`
5. Restart the server. The "Continue with Google" button now performs a real Google sign-in.

---

## 3. Project structure

```
servora-project/
  server/
    server.js              Express app entrypoint
    db.js                  File-backed JSON database (swap for Postgres later)
    middleware/auth.js     JWT auth + admin guard
    routes/auth.js         Signup, login, OTP, Google verification
    routes/professionals.js KYC upload (multer, real disk storage) + admin approval
    routes/bookings.js     Booking creation, Razorpay order + signature verification
    uploads/kyc/            <- real uploaded KYC files land here, per user
    data/db.json            <- the database file (created on first run)
    .env.example
  public/
    index.html              The full SERVORA site (customer + professional flows)
    admin.html               Admin panel for KYC review
    config.js                Public client-side config (Google Client ID)
```

## 4. Moving to production

### Database — now handled, just needs a connection string
The app now supports MongoDB directly (see `server/db.js`) instead of only a local JSON file. To switch:
1. Create a free MongoDB Atlas cluster: https://www.mongodb.com/cloud/atlas/register (no credit card needed for the M0 tier)
2. Database Access → add a database user (username + password)
3. Network Access → allow access from anywhere (`0.0.0.0/0`) to start — tighten later if you want
4. Connect → Drivers → copy the connection string into `MONGODB_URI` in `server/.env`
5. Restart the server. The startup log will confirm: `🗄️  MongoDB connected — data will persist across restarts and redeploys.`

Without `MONGODB_URI` set, the app keeps using the local JSON file exactly as before — nothing else changes, and nothing breaks either way. This matters because most hosting platforms (Render, Railway, Heroku, etc.) wipe local disk on every restart or redeploy — without a real database, every user, booking, and wallet balance would be lost the moment the server restarts.

### Security — hardened in this pass
- **Fixed a critical price-tampering bug**: booking price is now always looked up server-side from the services catalog and the client's price is ignored entirely — previously a tampered request could book any service for any price.
- Rate limiting on `/api/auth/*` (10 attempts / 15 min) and a baseline limit across the whole API.
- Security headers via Helmet (frame options, no-sniff, HSTS, etc.).
- CORS is now restrictive by default — set `ALLOWED_ORIGINS` in `.env` (comma-separated) only if the frontend is ever hosted on a different domain than the API.
- A global error handler + `asyncHandler` wrapper around async routes so one bad request can't crash the whole server.
- OTPs are now 6 digits instead of 4.
- Still worth doing before a public launch: a per-account login lockout after repeated failures, and a periodic dependency audit (`npm audit`).
- `npm audit` currently reports 0 known vulnerabilities (last checked when `google-auth-library` was upgraded to v11 to pull in a patched `gaxios`/`uuid`).

### Everything else before real customers use it
- Put the server behind HTTPS (e.g. deploy to Render, Railway, Fly.io, or a VPS with Caddy/Nginx + Let's Encrypt).
- Move `RAZORPAY_KEY_SECRET`, `JWT_SECRET`, `MONGODB_URI`, etc. into your hosting provider's secret manager rather than a committed `.env` file.
- Live voice/video calls are not built yet — everything else in the original spec (auth, KYC, payments, job matching, professional dashboard, cancel/refund, ratings, notifications, coupons, referrals, in-app chat, and an admin panel for services/areas/commission/coupons) is real and working.
