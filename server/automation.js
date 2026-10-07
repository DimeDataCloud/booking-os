// automation.js — the workflow engine. Rules run on a tick and on demand.
//
// Every rule is idempotent: it will not create a second open task for the same
// (rule, venue/booking) pair. That's the difference between an automation and a
// task-spam machine, and it's enforced by the dedupe key, not by convention.
import { db, now, logEvent } from './db.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString();
const dateOnly = (iso) => (iso || '').slice(0, 10);

// Match the full bracketed key, not a prefix — '%r1:v25%' would also hit r1:v250
// and the rule would silently stop firing for every venue whose id starts the same.
function taskExists(key) {
  return !!db.prepare("SELECT id FROM tasks WHERE detail LIKE ? AND status='open'").get('%[auto:' + key + ']%');
}

function createTask({ venue_id = null, booking_id = null, title, priority = 'normal', due_at = null, key, template = null }) {
  if (taskExists(key)) return null;
  const detail = `[auto:${key}]` + (template ? ` template:${template}` : '');
  const info = db.prepare('INSERT INTO tasks (venue_id,booking_id,title,detail,due_at,priority,status,auto,created_at) VALUES (?,?,?,?,?,?,\'open\',1,?)')
    .run(venue_id, booking_id, title, detail, due_at || now(), priority, now());
  return info.lastInsertRowid;
}

const RULES = {
  // A venue sitting in `contacted` with no activity for N days.
  no_reply_days(rule, p) {
    const cutoff = daysAgo(p.days ?? 5);
    const rows = db.prepare(`
      SELECT v.id, v.name FROM venues v
      WHERE v.stage = ? AND v.archived = 0
        AND COALESCE(v.last_contacted_at, v.updated_at) < ?
        AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.venue_id = v.id AND a.type = 'reply' AND a.created_at > ?)
    `).all(p.stage || 'contacted', cutoff, cutoff);
    return rows.map(v => createTask({
      venue_id: v.id, title: `${v.name} — ${rule.name}`, priority: rule.action_params.priority,
      key: `r${rule.id}:v${v.id}`, template: rule.action_params.template,
    }));
  },
  stage_age_days(rule, p) {
    const rows = db.prepare('SELECT id, name FROM venues WHERE stage=? AND archived=0 AND updated_at < ?')
      .all(p.stage, daysAgo(p.days ?? 7));
    return rows.map(v => createTask({
      venue_id: v.id, title: `${v.name} — ${rule.name}`, priority: rule.action_params.priority,
      key: `r${rule.id}:v${v.id}:${dateOnly(now())}`, template: rule.action_params.template,
    }));
  },
  booking_upcoming_days(rule, p) {
    const rows = db.prepare('SELECT b.id, b.title, b.date, b.venue_id FROM bookings b WHERE b.status=? AND b.date <= ? AND b.date >= ?')
      .all(p.status || 'confirmed', dateOnly(daysAhead(p.days ?? 7)), dateOnly(now()));
    return rows.map(b => createTask({
      venue_id: b.venue_id, booking_id: b.id, title: `${b.title} (${b.date}) — ${rule.name}`,
      priority: rule.action_params.priority, due_at: b.date, key: `r${rule.id}:b${b.id}`,
    }));
  },
  deposit_unpaid_days(rule, p) {
    const rows = db.prepare(`SELECT id, title, date, venue_id FROM bookings
      WHERE status='confirmed' AND deposit > 0 AND deposit_paid = 0 AND created_at < ?`).all(daysAgo(p.days ?? 3));
    return rows.map(b => createTask({
      venue_id: b.venue_id, booking_id: b.id, title: `${b.title} — deposit outstanding`,
      priority: 'high', key: `r${rule.id}:b${b.id}`,
    }));
  },
  played_days_ago(rule, p) {
    const rows = db.prepare("SELECT id, title, date, venue_id FROM bookings WHERE status='played' AND date <= ? AND date >= ?")
      .all(dateOnly(daysAgo(p.days ?? 10)), dateOnly(daysAgo((p.days ?? 10) + 20)));
    return rows.map(b => createTask({
      venue_id: b.venue_id, booking_id: b.id, title: `${b.title} — ${rule.name}`,
      priority: rule.action_params.priority, key: `r${rule.id}:b${b.id}`, template: rule.action_params.template,
    }));
  },
  payout_overdue_days(rule, p) {
    const rows = db.prepare(`SELECT id, title, date, venue_id, fee, paid FROM bookings
      WHERE status='played' AND COALESCE(paid,0) < fee AND date < ?`).all(dateOnly(daysAgo(p.days ?? 14)));
    return rows.map(b => createTask({
      venue_id: b.venue_id, booking_id: b.id,
      title: `${b.title} — $${Math.round((b.fee || 0) - (b.paid || 0))} unpaid since ${b.date}`,
      priority: 'high', key: `r${rule.id}:b${b.id}`,
    }));
  },
};

export function runAutomations() {
  const rules = db.prepare('SELECT * FROM automations WHERE enabled=1').all();
  let created = 0;
  const fired = [];
  for (const raw of rules) {
    const fn = RULES[raw.trigger];
    if (!fn) continue;
    const rule = { ...raw, action_params: safeJson(raw.action_params, {}) };
    let made = [];
    try { made = fn(rule, safeJson(raw.params, {})) || []; }
    catch (e) { console.error('automation', raw.name, e.message); continue; }
    const n = made.filter(Boolean).length;
    created += n;
    if (n) fired.push({ rule: raw.name, tasks: n });
    db.prepare('UPDATE automations SET last_run_at=?, run_count=run_count+? WHERE id=?').run(now(), n, raw.id);
  }
  if (created) logEvent('automation', `${created} task(s) created by ${fired.length} rule(s)`, JSON.stringify(fired));
  return { created, fired, ran_at: now() };
}

function safeJson(s, d) { try { return JSON.parse(s); } catch { return d; } }

// Stage transitions carry their own side effects — this is what makes the pipeline
// feel alive instead of being a dropdown that changes a string.
export function onStageChange(venueId, from, to, actor) {
  const v = db.prepare('SELECT * FROM venues WHERE id=?').get(venueId);
  if (!v) return;
  db.prepare('INSERT INTO activities (venue_id,type,subject,body,actor,created_at) VALUES (?,?,?,?,?,?)')
    .run(venueId, 'stage', `${from} → ${to}`, null, actor || 'system', now());
  const add = (title, days, priority = 'normal') => createTask({
    venue_id: venueId, title: `${v.name} — ${title}`, priority,
    due_at: daysAhead(days), key: `stage:${to}:v${venueId}`,
  });
  if (to === 'contacted') {
    db.prepare('UPDATE venues SET last_contacted_at=? WHERE id=?').run(now(), venueId);
    add('follow up if no reply', 5, 'high');
  }
  if (to === 'in_conversation') add('send mix + recent footage', 1, 'high');
  if (to === 'negotiating') add('send offer / hold confirmation', 1, 'high');
  if (to === 'booked') add('get the deposit and the agreement in writing', 2, 'high');
  if (to === 'played') add('send the rebook note', 10);
  logEvent('stage', `${v.name}: ${from} → ${to}`, String(venueId));
}
