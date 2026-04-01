const fs = require('fs');
const path = require('path');
const { sanitizeUpdate } = require('./middleware/sanitize');

const USE_MONGO = !!process.env.MONGODB_URI;

const DB_FILE = path.join(__dirname, 'gamezone-data.json');
const DEFAULTS = { users: [], groups: [], group_members: [], pcs: [], sessions: [], installed_apps: [] };

function loadJson() {
  if (!fs.existsSync(DB_FILE)) { fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULTS, null, 2)); return JSON.parse(JSON.stringify(DEFAULTS)); }
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}

let _saveQueue = Promise.resolve();
function saveJson(data) {
  _saveQueue = _saveQueue.then(() => {
    return new Promise((resolve) => {
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
      resolve();
    });
  });
  return _saveQueue;
}

let _db = loadJson();

const localDb = {
  all: (t) => _db[t] || [],
  get: (t, fn) => (_db[t] || []).find(fn) || null,
  filter: (t, fn) => (_db[t] || []).filter(fn),
  insert: async (t, row) => { if (!_db[t]) _db[t] = []; _db[t].push(row); await saveJson(_db); return row; },
  insertOrIgnore: async (t, row) => { if (!_db[t]) _db[t] = []; if (!_db[t].find(r => r.id === row.id)) { _db[t].push(row); await saveJson(_db); } return row; },
  update: async (t, fn, changes) => {
    if (!_db[t]) return;
    const safe = sanitizeUpdate(changes);
    _db[t] = _db[t].map(r => fn(r) ? { ...r, ...safe } : r);
    await saveJson(_db);
  },
  delete: async (t, fn) => { if (!_db[t]) return; _db[t] = _db[t].filter(r => !fn(r)); await saveJson(_db); },
};

let mongoDb = null;

async function initMongo() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  mongoDb = client.db('gamezone');
  console.log('[+] Connected to MongoDB');
}

const mongoWrapper = {
  all: async (t) => mongoDb.collection(t).find({}).toArray(),
  get: async (t, fn) => { const all = await mongoDb.collection(t).find({}).toArray(); return all.find(fn) || null; },
  filter: async (t, fn) => { const all = await mongoDb.collection(t).find({}).toArray(); return all.filter(fn); },
  insert: async (t, row) => { await mongoDb.collection(t).insertOne(row); return row; },
  insertOrIgnore: async (t, row) => { await mongoDb.collection(t).updateOne({ id: row.id }, { $setOnInsert: row }, { upsert: true }); return row; },
  update: async (t, fn, changes) => {
    const all = await mongoDb.collection(t).find({}).toArray();
    const safe = sanitizeUpdate(changes);
    const matchIds = all.filter(fn).map(r => r.id);
    if (matchIds.length > 0) {
      await mongoDb.collection(t).updateMany({ id: { $in: matchIds } }, { $set: safe });
    }
  },
  delete: async (t, fn) => {
    const all = await mongoDb.collection(t).find({}).toArray();
    const matchIds = all.filter(fn).map(r => r.id);
    if (matchIds.length > 0) {
      await mongoDb.collection(t).deleteMany({ id: { $in: matchIds } });
    }
  },
};

const db = {
  _ready: USE_MONGO ? initMongo() : Promise.resolve(),
  all: (t) => USE_MONGO ? mongoWrapper.all(t) : Promise.resolve(localDb.all(t)),
  get: (t, fn) => USE_MONGO ? mongoWrapper.get(t, fn) : Promise.resolve(localDb.get(t, fn)),
  filter: (t, fn) => USE_MONGO ? mongoWrapper.filter(t, fn) : Promise.resolve(localDb.filter(t, fn)),
  insert: (t, row) => USE_MONGO ? mongoWrapper.insert(t, row) : Promise.resolve(localDb.insert(t, row)),
  insertOrIgnore: (t, row) => USE_MONGO ? mongoWrapper.insertOrIgnore(t, row) : Promise.resolve(localDb.insertOrIgnore(t, row)),
  update: (t, fn, changes) => USE_MONGO ? mongoWrapper.update(t, fn, changes) : Promise.resolve(localDb.update(t, fn, changes)),
  delete: (t, fn) => USE_MONGO ? mongoWrapper.delete(t, fn) : Promise.resolve(localDb.delete(t, fn)),
};

module.exports = db;
