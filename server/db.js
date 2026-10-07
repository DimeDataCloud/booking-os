// db.js — schema, migrations, seeding. node:sqlite (built in, no native build step).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { scoreVenue, AREAS } from './leadgen.js';
import { seedDemo } from './demo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'booking.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'manager',
  pw TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_id TEXT UNIQUE,
  name TEXT NOT NULL,
  venue_type TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT,
  area TEXT, area_label TEXT,
  lat REAL, lng REAL,
  capacity INTEGER, capacity_estimated INTEGER DEFAULT 1,
  website TEXT, email TEXT, emails_all TEXT, phone TEXT,
  instagram TEXT, facebook TEXT, tiktok_handle TEXT,
  opening_hours TEXT,
  contact_name TEXT, contact_role TEXT,
  stage TEXT NOT NULL DEFAULT 'prospect',
  score INTEGER DEFAULT 0, score_reasons TEXT,
  fee_target REAL,
  genre TEXT,
  notes TEXT,
  enrich_note TEXT, enriched_at TEXT,
  source TEXT DEFAULT 'openstreetmap',
  last_contacted_at TEXT,
  next_action TEXT, next_action_at TEXT,
  archived INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_venues_stage ON venues(stage);
CREATE INDEX IF NOT EXISTS idx_venues_area ON venues(area);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  booking_id INTEGER,
  type TEXT NOT NULL,
  channel TEXT,
  subject TEXT,
  body TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_venue ON activities(venue_id);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT, end_time TEXT,
  status TEXT NOT NULL DEFAULT 'hold',
  fee REAL DEFAULT 0,
  deposit REAL DEFAULT 0,
  deposit_paid INTEGER DEFAULT 0,
  paid REAL DEFAULT 0,
  payout_status TEXT DEFAULT 'unpaid',
  set_length INTEGER,
  travel_cost REAL DEFAULT 0,
  contract_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_date ON bookings(date);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT,
  due_at TEXT,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'open',
  auto INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT,
  body TEXT NOT NULL,
  stage TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  action_params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT, run_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, message TEXT NOT NULL, ref TEXT,
  created_at TEXT NOT NULL
);
`);

export const now = () => new Date().toISOString();

// ─── auth helpers ──────────────────────────────────────────────────────────────
export function hashPw(pw) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(pw, salt, 64).toString('hex');
}
export function checkPw(pw, stored) {
  try {
    const [salt, key] = String(stored).split(':');
    const a = Buffer.from(key, 'hex');
    const b = scryptSync(pw, salt, 64);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

export function setting(k, v) {
  if (v === undefined) {
    const row = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
    return row ? JSON.parse(row.v) : null;
  }
  db.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));
  return v;
}

export function logEvent(kind, message, ref) {
  db.prepare('INSERT INTO events (kind,message,ref,created_at) VALUES (?,?,?,?)').run(kind, message, ref || null, now());
  db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id)-500 FROM events)').run();
}

// ─── seeding ───────────────────────────────────────────────────────────────────
const DEFAULT_TEMPLATES = [
  {
    name: 'Cold intro — club talent buyer', channel: 'email', stage: 'prospect',
    subject: '{{artist}} — open {{month}} dates for {{venue}}',
    body: `Hi{{contact_first}},

I manage {{artist}}, a DJ based in {{home_base}}. Mixes are on Spotify ({{spotify}}) and TikTok ({{tiktok}}).

I'm putting together {{month}} and {{venue}} is on my shortlist. {{artist}} plays open-to-close or support depending on what the room needs, and I can send a mix plus recent room footage.

What's your booking process, and who handles talent for {{venue}}?

{{signature}}`,
  },
  {
    name: 'Follow-up #1 — 5 days, no reply', channel: 'email', stage: 'contacted',
    subject: 'Re: {{artist}} — {{venue}}',
    body: `Hi{{contact_first}}, following up on the note below in case it got buried.

Short version: {{artist}}, available {{month}} for {{venue}}. Mix and footage ready to send, and I can work around your resident schedule.

Worth a 10-minute call?

{{signature}}`,
  },
  {
    name: 'Instagram DM — cold', channel: 'instagram', stage: 'prospect',
    subject: null,
    body: `Hey {{venue}}, I manage {{artist}} (DJ, {{home_base}}). Looking at {{month}} dates and your room fits. Who handles bookings? Happy to send a mix and recent footage.`,
  },
  {
    name: 'Offer / hold confirmation', channel: 'email', stage: 'negotiating',
    subject: 'Hold — {{artist}} at {{venue}}, {{date}}',
    body: `Confirming what we discussed:

· Date: {{date}}
· Set: {{set_length}} minutes
· Fee: {{fee}} ({{deposit}} deposit to confirm)
· {{artist}} handles their own promo push to their list and socials

Send over the agreement whenever you're ready and I'll return it same day.

{{signature}}`,
  },
  {
    name: 'Post-gig — rebook', channel: 'email', stage: 'played',
    subject: 'Last {{date}} at {{venue}} — next one?',
    body: `Thanks again for {{date}}, the room worked. We clipped the set for socials and tagged {{venue}}.

Want to lock a recurring slot? Booking a monthly gets you a better rate than one-offs.

{{signature}}`,
  },
];

const DEFAULT_AUTOMATIONS = [
  { name: 'Follow up 5 days after first contact', trigger: 'no_reply_days', params: { days: 5, stage: 'contacted' }, action: 'create_task', action_params: { title: 'Follow up — no reply in 5 days', priority: 'high', template: 'Follow-up #1 — 5 days, no reply' } },
  { name: 'Chase stale negotiations', trigger: 'stage_age_days', params: { days: 7, stage: 'negotiating' }, action: 'create_task', action_params: { title: 'Negotiation stalled 7 days — call the venue', priority: 'high' } },
  { name: 'Advance week-of a confirmed booking', trigger: 'booking_upcoming_days', params: { days: 7, status: 'confirmed' }, action: 'create_task', action_params: { title: 'Advance the show — set time, sound, guest list, payment terms', priority: 'high' } },
  { name: 'Collect deposit on confirmed bookings', trigger: 'deposit_unpaid_days', params: { days: 3 }, action: 'create_task', action_params: { title: 'Deposit outstanding — chase it', priority: 'high' } },
  { name: 'Rebook 10 days after a played show', trigger: 'played_days_ago', params: { days: 10 }, action: 'create_task', action_params: { title: 'Send the rebook note', priority: 'normal', template: 'Post-gig — rebook' } },
  { name: 'Payout not received 14 days after the show', trigger: 'payout_overdue_days', params: { days: 14 }, action: 'create_task', action_params: { title: 'Unpaid gig — invoice the venue', priority: 'high' } },
];

export function seed() {
  const seededUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (!seededUsers) {
    const pw = process.env.ADMIN_PASSWORD || 'changeme2026';
    if (!process.env.ADMIN_PASSWORD) console.warn('[auth] ADMIN_PASSWORD not set: seeded manager uses the default password, change it after first login');
    db.prepare('INSERT INTO users (email,name,role,pw,created_at) VALUES (?,?,?,?,?)')
      .run((process.env.ADMIN_EMAIL || 'manager@example.com').toLowerCase().trim(), process.env.ADMIN_NAME || 'Manager', 'manager', hashPw(pw), now());
  }

  if (!db.prepare('SELECT COUNT(*) c FROM templates').get().c) {
    const ins = db.prepare('INSERT INTO templates (name,channel,subject,body,stage,created_at) VALUES (?,?,?,?,?,?)');
    for (const t of DEFAULT_TEMPLATES) ins.run(t.name, t.channel, t.subject, t.body, t.stage, now());
  }

  if (!db.prepare('SELECT COUNT(*) c FROM automations').get().c) {
    const ins = db.prepare('INSERT INTO automations (name,trigger,params,action,action_params,enabled,created_at) VALUES (?,?,?,?,?,1,?)');
    for (const a of DEFAULT_AUTOMATIONS) ins.run(a.name, a.trigger, JSON.stringify(a.params), a.action, JSON.stringify(a.action_params), now());
  }

  if (!setting('artist')) {
    setting('artist', {
      name: 'Your Artist',
      tagline: 'DJ',
      spotify: 'https://open.spotify.com/artist/your-artist-id',
      spotify_id: '',
      tiktok: 'https://www.tiktok.com/@your.handle',
      tiktok_handle: 'your.handle',
      manager: process.env.ADMIN_NAME || 'Manager',
      manager_email: process.env.ADMIN_EMAIL || 'manager@example.com',
      base_fee: 500,
      signature: 'Management',
      home_base: 'Berlin',
    });
  }

  if (!db.prepare('SELECT COUNT(*) c FROM venues').get().c) {
    const seedFile = join(ROOT, 'data', 'seed-venues.json');
    if (existsSync(seedFile)) {
      try { importVenues(JSON.parse(readFileSync(seedFile, 'utf8'))); }
      catch (e) { console.error('seed import failed:', e.message); }
    } else if (process.env.DEMO_SEED !== '0') {
      seedDemo(db, { AREAS, importVenues, now });
    }
  }
}

// Upsert on osm_id — a re-sweep updates contact data without clobbering pipeline state.
export function importVenues(list) {
  const insert = db.prepare(`INSERT INTO venues
    (osm_id,name,venue_type,address,city,state,zip,area,area_label,lat,lng,capacity,capacity_estimated,
     website,email,emails_all,phone,instagram,facebook,tiktok_handle,opening_hours,score,score_reasons,
     enrich_note,enriched_at,source,stage,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prospect',?,?)`);
  const update = db.prepare(`UPDATE venues SET
     name=?, venue_type=?, address=COALESCE(?,address), city=COALESCE(?,city), lat=?, lng=?,
     capacity=COALESCE(?,capacity), website=COALESCE(?,website), email=COALESCE(email,?),
     emails_all=COALESCE(?,emails_all), phone=COALESCE(phone,?), instagram=COALESCE(instagram,?),
     facebook=COALESCE(facebook,?), score=?, score_reasons=?, enrich_note=COALESCE(?,enrich_note),
     enriched_at=COALESCE(?,enriched_at), updated_at=?
     WHERE osm_id=?`);
  const find = db.prepare('SELECT id FROM venues WHERE osm_id=?');
  let added = 0, updated = 0;
  for (const v of list) {
    if (!v || v.__error || !v.name) continue;
    const { score, reasons } = scoreVenue(v);
    const reasonStr = JSON.stringify(v.score_reasons || reasons);
    const emailsAll = v.emails_all ? JSON.stringify(v.emails_all) : null;
    const existing = v.osm_id ? find.get(v.osm_id) : null;
    if (existing) {
      update.run(v.name, v.venue_type || null, v.address || null, v.city || null, v.lat, v.lng,
        v.capacity || null, v.website || null, v.email || null, emailsAll, v.phone || null,
        v.instagram || null, v.facebook || null, v.score ?? score, reasonStr,
        v.enrich_note || null, v.enriched_at || null, now(), v.osm_id);
      updated++;
    } else {
      insert.run(v.osm_id || null, v.name, v.venue_type || null, v.address || null, v.city || null,
        v.state || null, v.zip || null, v.area || null, v.area_label || null, v.lat ?? null, v.lng ?? null,
        v.capacity ?? null, v.capacity_estimated ?? 1, v.website || null, v.email || null, emailsAll,
        v.phone || null, v.instagram || null, v.facebook || null, v.tiktok_handle || null,
        v.opening_hours || null, v.score ?? score, reasonStr, v.enrich_note || null, v.enriched_at || null,
        v.source || 'openstreetmap', now(), now());
      added++;
    }
  }
  return { added, updated };
}

export const STAGES = ['prospect', 'researching', 'contacted', 'in_conversation', 'negotiating', 'booked', 'played', 'repeat', 'passed'];
export const STAGE_LABELS = {
  prospect: 'Prospect', researching: 'Researching', contacted: 'Contacted', in_conversation: 'In conversation',
  negotiating: 'Negotiating', booked: 'Booked', played: 'Played', repeat: 'Repeat client', passed: 'Passed',
};
