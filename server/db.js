// Database layer. Two modes:
//
//  1. MONGODB_URI is set  -> data is stored in MongoDB (Atlas free tier works great).
//     This is REQUIRED for real deployments: most hosting platforms (Render, Railway,
//     Heroku, etc.) wipe local disk on every restart/redeploy, so a JSON file alone
//     will lose all users, bookings, and money records the moment the server restarts.
//
//  2. MONGODB_URI is NOT set -> falls back to a local JSON file (server/data/db.json),
//     exactly like before. Fine for local development, NOT safe for production.
//
// Every route file keeps using the exact same lowdb chain API
// (db.get('users').find(...).value(), .push().write(), etc.) in both modes —
// nothing else in the codebase needs to change.

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const Memory = require('lowdb/adapters/Memory');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const DEFAULTS = {
  users: [],          // {id, name, email, mobile, passwordHash, provider, createdAt}
  otps: [],            // {id, target, code, purpose, expiresAt, used}
  professionals: [],   // KYC + profile records, status: pending|approved|rejected
  bookings: [],        // {id, userId, service, price, ..., status, professionalId, rejectedBy}
  wallets: [],         // {userId, balance, txns:[]}
  withdrawals: [],     // {id, professionalId, amount, status: pending|paid, requestedAt, paidAt}
  refundRequests: [],  // {id, bookingId, userId, amount, reason, status: pending|approved|rejected, requestedAt}
  reviews: [],         // {id, bookingId, userId, professionalId, rating, comment, createdAt}
  notifications: [],   // {id, userId, type, title, message, link, read, createdAt}
  services: [          // {id, icon, name, desc, tag, price, active}
    { id: 'svc_electrician', icon: 'fa-bolt', name: 'Electrician', desc: 'Wiring, fittings, repairs & installations.', tag: 'popular', price: 399, active: true },
    { id: 'svc_plumber', icon: 'fa-faucet-drip', name: 'Plumber', desc: 'Leaks, fittings, tanks & bathroom fixes.', tag: 'popular', price: 349, active: true },
    { id: 'svc_ac', icon: 'fa-fan', name: 'AC & Appliance Repair', desc: 'ACs, fridges, washing machines & more.', tag: 'popular', price: 599, active: true },
    { id: 'svc_carpenter', icon: 'fa-hammer', name: 'Carpenter', desc: 'Furniture repair, fittings & custom work.', tag: 'home', price: 449, active: true },
    { id: 'svc_painter', icon: 'fa-paint-roller', name: 'Painter', desc: 'Interior & exterior painting, touch-ups.', tag: 'home', price: 1499, active: true },
    { id: 'svc_cleaning', icon: 'fa-broom', name: 'Home Cleaning', desc: 'Deep cleaning, sofa & kitchen cleaning.', tag: 'home', price: 699, active: true },
    { id: 'svc_pest', icon: 'fa-bug-slash', name: 'Pest Control', desc: 'Termite, cockroach & rodent treatment.', tag: 'home', price: 899, active: true },
    { id: 'svc_cctv', icon: 'fa-video', name: 'CCTV & Security', desc: 'Camera installation & smart locks.', tag: 'security', price: 1299, active: true },
    { id: 'svc_salon', icon: 'fa-scissors', name: 'Salon at Home', desc: 'Haircuts, grooming & spa services.', tag: 'personal', price: 499, active: true },
    { id: 'svc_movers', icon: 'fa-truck-moving', name: 'Packers & Movers', desc: 'Local shifting, packing & loading.', tag: 'other', price: 1999, active: true },
    { id: 'svc_vehicle', icon: 'fa-car', name: 'Vehicle Care', desc: 'Doorstep car & bike cleaning, servicing.', tag: 'other', price: 349, active: true },
    { id: 'svc_garden', icon: 'fa-seedling', name: 'Gardening', desc: 'Lawn care, planting & maintenance.', tag: 'home', price: 399, active: true }
  ],
  settings: { commissionPct: 15 },  // singleton object, not an array
  blocks: [             // {id, name, isHQ, active} — service areas within the district
    { id: 'blk_narnaul', name: 'Narnaul', isHQ: true, active: true },
    { id: 'blk_mahendragarh', name: 'Mahendragarh', isHQ: false, active: true },
    { id: 'blk_kanina', name: 'Kanina', isHQ: false, active: true },
    { id: 'blk_ateli', name: 'Ateli', isHQ: false, active: true },
    { id: 'blk_nangalchaudhary', name: 'Nangal Chaudhary', isHQ: false, active: true },
    { id: 'blk_nizampur', name: 'Nizampur', isHQ: false, active: true },
    { id: 'blk_sihma', name: 'Sihma', isHQ: false, active: true },
    { id: 'blk_satnali', name: 'Satnali', isHQ: false, active: true }
  ],
  coupons: [],          // {id, code, type: percent|flat, value, maxDiscount, minOrderValue, usageLimit, usedCount, expiresAt, active}
  referrals: [],        // {id, referrerUserId, refereeUserId, rewardAmount, status: pending|rewarded, createdAt}
  messages: []          // {id, bookingId, senderId, senderRole: customer|professional, text, createdAt}
};

let dbInstance = null;
let mongoCollection = null;

async function initDb() {
  if (process.env.MONGODB_URI) {
    const client = new MongoClient(process.env.MONGODB_URI);
    try {
      await client.connect();
    } catch (e) {
      console.error('❌ Could not connect to MongoDB with the MONGODB_URI in your .env:', e.message);
      console.error('   Check the connection string, your Atlas IP allowlist, and your username/password.');
      process.exit(1);
    }
    const dbName = process.env.MONGODB_DB_NAME || 'servora';
    mongoCollection = client.db(dbName).collection('app_state');

    const existing = await mongoCollection.findOne({ _id: 'state' });
    const initialData = existing ? existing.data : {};
    dbInstance = low(new Memory(initialData));
    console.log('🗄️  MongoDB connected — data will persist across restarts and redeploys.');
  } else {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    dbInstance = low(new FileSync(path.join(dataDir, 'db.json')));
    console.log('⚠️  No MONGODB_URI set — using a local JSON file (server/data/db.json).');
    console.log('   This is fine for local development, but most hosting platforms wipe local');
    console.log('   disk on every restart/redeploy. Set MONGODB_URI before deploying for real.');
  }

  dbInstance.defaults(DEFAULTS).write();

  // In Mongo mode, every .write() call also persists the full in-memory state to
  // MongoDB in the background, so nothing else in the app needs to change.
  if (mongoCollection) {
    const originalWrite = dbInstance.write.bind(dbInstance);
    dbInstance.write = (...args) => {
      const result = originalWrite(...args);
      mongoCollection.replaceOne(
        { _id: 'state' },
        { _id: 'state', data: dbInstance.getState(), updatedAt: new Date() },
        { upsert: true }
      ).catch(err => console.error('⚠️  Failed to persist a change to MongoDB:', err.message));
      return result;
    };
  }

  return dbInstance;
}

// Routes do `const db = require('../db')` at module load time, then call
// db.get(...) later, inside request handlers — well after initDb() has
// finished (server.js awaits it before calling app.listen()). This proxy
// just forwards every call to the real lowdb instance once it exists.
const proxy = new Proxy({}, {
  get(target, prop) {
    if (prop === 'initDb') return initDb;
    if (!dbInstance) {
      throw new Error('Database accessed before initDb() completed — this should never happen after server startup.');
    }
    const value = dbInstance[prop];
    return typeof value === 'function' ? value.bind(dbInstance) : value;
  }
});

module.exports = proxy;
