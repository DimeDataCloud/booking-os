// api.js — every JSON route. Handlers return a value (serialised as JSON) or throw HttpError.
import { db, now, setting, logEvent, importVenues, STAGES, STAGE_LABELS, checkPw, hashPw } from './db.js';
import { discover, enrich, scoreVenue, AREAS } from './leadgen.js';
import { runAutomations, onStageChange } from './automation.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => { throw new HttpError(400, m); };
const missing = (m) => { throw new HttpError(404, m); };

const parseJson = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

function venueRow(v) {
  if (!v) return v;
  return { ...v, emails_all: parseJson(v.emails_all, []), score_reasons: parseJson(v.score_reasons, []) };
}

// ─── venues ────────────────────────────────────────────────────────────────────
const VENUE_FIELDS = ['name', 'venue_type', 'address', 'city', 'state', 'zip', 'area', 'area_label', 'lat', 'lng',
  'capacity', 'website', 'email', 'phone', 'instagram', 'facebook', 'tiktok_handle', 'contact_name', 'contact_role',
  'stage', 'fee_target', 'genre', 'notes', 'next_action', 'next_action_at', 'last_contacted_at', 'archived'];

export const routes = {
  'GET /api/bootstrap': (ctx) => ({
    user: ctx.user,
    artist: setting('artist'),
    stages: STAGES.map(s => ({ key: s, label: STAGE_LABELS[s] })),
    areas: Object.entries(AREAS).map(([k, a]) => ({ key: k, label: a.label, state: a.state })),
    counts: {
      venues: db.prepare('SELECT COUNT(*) c FROM venues WHERE archived=0').get().c,
      withEmail: db.prepare("SELECT COUNT(*) c FROM venues WHERE archived=0 AND email IS NOT NULL AND email <> ''").get().c,
      withPhone: db.prepare("SELECT COUNT(*) c FROM venues WHERE archived=0 AND phone IS NOT NULL AND phone <> ''").get().c,
      openTasks: db.prepare("SELECT COUNT(*) c FROM tasks WHERE status='open'").get().c,
      bookings: db.prepare("SELECT COUNT(*) c FROM bookings WHERE status IN ('hold','confirmed')").get().c,
    },
  }),

  'GET /api/venues': (ctx) => {
    const q = ctx.query;
    const where = ['archived = ' + (q.archived === '1' ? 1 : 0)];
    const args = [];
    if (q.stage && q.stage !== 'all') { where.push('stage = ?'); args.push(q.stage); }
    if (q.area && q.area !== 'all') { where.push('area = ?'); args.push(q.area); }
    if (q.state && q.state !== 'all') { where.push('state = ?'); args.push(q.state); }
    if (q.has === 'email') where.push("email IS NOT NULL AND email <> ''");
    if (q.has === 'phone') where.push("phone IS NOT NULL AND phone <> ''");
    if (q.has === 'contact') where.push("((email IS NOT NULL AND email <> '') OR (phone IS NOT NULL AND phone <> ''))");
    if (q.q) { where.push('(name LIKE ? OR city LIKE ? OR COALESCE(email,\'\') LIKE ? OR COALESCE(notes,\'\') LIKE ?)'); const s = `%${q.q}%`; args.push(s, s, s, s); }
    const sort = { score: 'score DESC, capacity DESC', name: 'name COLLATE NOCASE ASC', capacity: 'capacity DESC', recent: 'updated_at DESC' }[q.sort] || 'score DESC, capacity DESC';
    const limit = Math.min(parseInt(q.limit || '500', 10) || 500, 2000);
    const rows = db.prepare(`SELECT * FROM venues WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ?`).all(...args, limit);
    const total = db.prepare(`SELECT COUNT(*) c FROM venues WHERE ${where.join(' AND ')}`).get(...args).c;
    return { venues: rows.map(venueRow), total };
  },

  'GET /api/venues/:id': (ctx) => {
    const v = db.prepare('SELECT * FROM venues WHERE id=?').get(ctx.params.id) || missing('venue');
    return {
      venue: venueRow(v),
      activities: db.prepare('SELECT * FROM activities WHERE venue_id=? ORDER BY created_at DESC LIMIT 100').all(v.id),
      bookings: db.prepare('SELECT * FROM bookings WHERE venue_id=? ORDER BY date DESC').all(v.id),
      tasks: db.prepare("SELECT * FROM tasks WHERE venue_id=? AND status='open' ORDER BY due_at").all(v.id),
    };
  },

  'POST /api/venues': (ctx) => {
    const b = ctx.body || {};
    if (!b.name) bad('name required');
    const cols = VENUE_FIELDS.filter(f => b[f] !== undefined);
    const sql = `INSERT INTO venues (${[...cols, 'source', 'created_at', 'updated_at'].join(',')}) VALUES (${cols.map(() => '?').join(',')},?,?,?)`;
    const info = db.prepare(sql).run(...cols.map(c => b[c] ?? null), b.source || 'manual', now(), now());
    const v = db.prepare('SELECT * FROM venues WHERE id=?').get(info.lastInsertRowid);
    const { score, reasons } = scoreVenue(v);
    db.prepare('UPDATE venues SET score=?, score_reasons=? WHERE id=?').run(score, JSON.stringify(reasons), v.id);
    logEvent('venue', `added ${v.name}`, String(v.id));
    return venueRow(db.prepare('SELECT * FROM venues WHERE id=?').get(v.id));
  },

  'PATCH /api/venues/:id': (ctx) => {
    const id = ctx.params.id;
    const prev = db.prepare('SELECT * FROM venues WHERE id=?').get(id) || missing('venue');
    const b = ctx.body || {};
    const cols = VENUE_FIELDS.filter(f => b[f] !== undefined);
    if (!cols.length) bad('nothing to update');
    db.prepare(`UPDATE venues SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`)
      .run(...cols.map(c => b[c]), now(), id);
    const next = db.prepare('SELECT * FROM venues WHERE id=?').get(id);
    const { score, reasons } = scoreVenue(next);
    db.prepare('UPDATE venues SET score=?, score_reasons=? WHERE id=?').run(score, JSON.stringify(reasons), id);
    if (b.stage && b.stage !== prev.stage) onStageChange(id, prev.stage, b.stage, ctx.user?.name);
    return venueRow(db.prepare('SELECT * FROM venues WHERE id=?').get(id));
  },

  'DELETE /api/venues/:id': (ctx) => {
    db.prepare('UPDATE venues SET archived=1, updated_at=? WHERE id=?').run(now(), ctx.params.id);
    return { ok: true };
  },

  'POST /api/venues/:id/activity': (ctx) => {
    const v = db.prepare('SELECT * FROM venues WHERE id=?').get(ctx.params.id) || missing('venue');
    const b = ctx.body || {};
    if (!b.type) bad('type required');
    db.prepare('INSERT INTO activities (venue_id,type,channel,subject,body,actor,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(v.id, b.type, b.channel || null, b.subject || null, b.body || null, ctx.user?.name || 'user', now());
    // Logging an outbound touch is what "contacted" actually means — set it here, not by hand.
    if (['email', 'call', 'dm', 'text'].includes(b.type)) {
      db.prepare('UPDATE venues SET last_contacted_at=?, updated_at=? WHERE id=?').run(now(), now(), v.id);
      if (['prospect', 'researching'].includes(v.stage)) {
        db.prepare("UPDATE venues SET stage='contacted' WHERE id=?").run(v.id);
        onStageChange(v.id, v.stage, 'contacted', ctx.user?.name);
      }
    }
    return { ok: true, activities: db.prepare('SELECT * FROM activities WHERE venue_id=? ORDER BY created_at DESC LIMIT 100').all(v.id) };
  },

  'POST /api/venues/:id/enrich': async (ctx) => {
    const v = db.prepare('SELECT * FROM venues WHERE id=?').get(ctx.params.id) || missing('venue');
    const r = await enrich(v);
    db.prepare(`UPDATE venues SET email=COALESCE(NULLIF(email,''),?), emails_all=?, phone=COALESCE(NULLIF(phone,''),?),
      instagram=COALESCE(NULLIF(instagram,''),?), facebook=COALESCE(NULLIF(facebook,''),?),
      enrich_note=?, enriched_at=?, updated_at=? WHERE id=?`)
      .run(r.emails[0] || null, JSON.stringify(r.emails), r.phones[0] || null, r.instagram, r.facebook,
        r.notes, now(), now(), v.id);
    const next = db.prepare('SELECT * FROM venues WHERE id=?').get(v.id);
    const { score, reasons } = scoreVenue(next);
    db.prepare('UPDATE venues SET score=?, score_reasons=? WHERE id=?').run(score, JSON.stringify(reasons), v.id);
    logEvent('enrich', `${v.name}: ${r.emails.length} email(s), ${r.phones.length} phone(s)`, String(v.id));
    return { venue: venueRow(db.prepare('SELECT * FROM venues WHERE id=?').get(v.id)), result: r };
  },

  // ─── lead generator ──────────────────────────────────────────────────────────
  'POST /api/leadgen/run': async (ctx) => {
    const b = ctx.body || {};
    const areas = Array.isArray(b.areas) && b.areas.length ? b.areas : null;
    const found = await discover(areas, { limit: num(b.limit, 600) });
    const errors = found.filter(v => v.__error).map(v => v.__error);
    const clean = found.filter(v => !v.__error);
    const { added, updated } = importVenues(clean);
    logEvent('leadgen', `sweep: ${clean.length} found, ${added} new, ${updated} updated`, null);

    let enriched = 0;
    if (b.enrich !== false) {
      const cap = Math.min(num(b.enrichLimit, 25), 60);
      const targets = db.prepare(`SELECT * FROM venues WHERE archived=0 AND website IS NOT NULL AND website <> ''
        AND (email IS NULL OR email = '') AND enriched_at IS NULL ORDER BY score DESC LIMIT ?`).all(cap);
      for (let i = 0; i < targets.length; i += 5) {
        await Promise.all(targets.slice(i, i + 5).map(async v => {
          try {
            const r = await enrich(v);
            db.prepare(`UPDATE venues SET email=COALESCE(NULLIF(email,''),?), emails_all=?, phone=COALESCE(NULLIF(phone,''),?),
              instagram=COALESCE(NULLIF(instagram,''),?), facebook=COALESCE(NULLIF(facebook,''),?), enrich_note=?, enriched_at=?, updated_at=? WHERE id=?`)
              .run(r.emails[0] || null, JSON.stringify(r.emails), r.phones[0] || null, r.instagram, r.facebook, r.notes, now(), now(), v.id);
            const nv = db.prepare('SELECT * FROM venues WHERE id=?').get(v.id);
            const { score, reasons } = scoreVenue(nv);
            db.prepare('UPDATE venues SET score=?, score_reasons=? WHERE id=?').run(score, JSON.stringify(reasons), v.id);
            if (r.emails.length) enriched++;
          } catch { /* a single unreachable site must not fail the sweep */ }
        }));
      }
    }
    return { found: clean.length, added, updated, enriched, errors };
  },

  // ─── bookings ────────────────────────────────────────────────────────────────
  'GET /api/bookings': (ctx) => {
    const q = ctx.query;
    const where = [], args = [];
    if (q.from) { where.push('date >= ?'); args.push(q.from); }
    if (q.to) { where.push('date <= ?'); args.push(q.to); }
    if (q.status && q.status !== 'all') { where.push('status = ?'); args.push(q.status); }
    const sql = `SELECT b.*, v.name venue_name, v.city venue_city, v.state venue_state, v.lat, v.lng
      FROM bookings b LEFT JOIN venues v ON v.id = b.venue_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date ASC`;
    return { bookings: db.prepare(sql).all(...args) };
  },

  'POST /api/bookings': (ctx) => {
    const b = ctx.body || {};
    if (!b.date) bad('date required');
    const venue = b.venue_id ? db.prepare('SELECT * FROM venues WHERE id=?').get(b.venue_id) : null;
    const title = b.title || (venue ? `${setting('artist')?.name || 'Set'} @ ${venue.name}` : 'Set');
    const info = db.prepare(`INSERT INTO bookings
      (venue_id,title,date,start_time,end_time,status,fee,deposit,deposit_paid,paid,payout_status,set_length,travel_cost,contract_url,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      b.venue_id || null, title, b.date, b.start_time || null, b.end_time || null, b.status || 'hold',
      num(b.fee), num(b.deposit), b.deposit_paid ? 1 : 0, num(b.paid), b.payout_status || 'unpaid',
      b.set_length ? parseInt(b.set_length, 10) : null, num(b.travel_cost), b.contract_url || null, b.notes || null, now(), now());
    if (venue && !['booked', 'played', 'repeat'].includes(venue.stage)) {
      db.prepare("UPDATE venues SET stage='booked', updated_at=? WHERE id=?").run(now(), venue.id);
      onStageChange(venue.id, venue.stage, 'booked', ctx.user?.name);
    }
    logEvent('booking', `${title} on ${b.date}`, String(info.lastInsertRowid));
    return db.prepare('SELECT * FROM bookings WHERE id=?').get(info.lastInsertRowid);
  },

  'PATCH /api/bookings/:id': (ctx) => {
    const b = ctx.body || {};
    const prev = db.prepare('SELECT * FROM bookings WHERE id=?').get(ctx.params.id) || missing('booking');
    const fields = ['venue_id', 'title', 'date', 'start_time', 'end_time', 'status', 'fee', 'deposit', 'deposit_paid', 'paid', 'payout_status', 'set_length', 'travel_cost', 'contract_url', 'notes'];
    const cols = fields.filter(f => b[f] !== undefined);
    if (!cols.length) bad('nothing to update');
    db.prepare(`UPDATE bookings SET ${cols.map(c => c + '=?').join(',')}, updated_at=? WHERE id=?`)
      .run(...cols.map(c => (c === 'deposit_paid' ? (b[c] ? 1 : 0) : b[c])), now(), ctx.params.id);
    const next = db.prepare('SELECT * FROM bookings WHERE id=?').get(ctx.params.id);
    if (next.status === 'played' && prev.status !== 'played' && next.venue_id) {
      const v = db.prepare('SELECT * FROM venues WHERE id=?').get(next.venue_id);
      const played = db.prepare("SELECT COUNT(*) c FROM bookings WHERE venue_id=? AND status='played'").get(next.venue_id).c;
      const stage = played > 1 ? 'repeat' : 'played';
      if (v && v.stage !== stage) { db.prepare('UPDATE venues SET stage=?, updated_at=? WHERE id=?').run(stage, now(), v.id); onStageChange(v.id, v.stage, stage, ctx.user?.name); }
    }
    return next;
  },

  'DELETE /api/bookings/:id': (ctx) => { db.prepare('DELETE FROM bookings WHERE id=?').run(ctx.params.id); return { ok: true }; },

  // ─── tasks ───────────────────────────────────────────────────────────────────
  'GET /api/tasks': (ctx) => {
    const status = ctx.query.status || 'open';
    const sql = `SELECT t.*, v.name venue_name, b.date booking_date FROM tasks t
      LEFT JOIN venues v ON v.id=t.venue_id LEFT JOIN bookings b ON b.id=t.booking_id
      ${status === 'all' ? '' : 'WHERE t.status = ?'} ORDER BY (t.priority='high') DESC, t.due_at ASC LIMIT 300`;
    return { tasks: status === 'all' ? db.prepare(sql).all() : db.prepare(sql).all(status) };
  },
  'POST /api/tasks': (ctx) => {
    const b = ctx.body || {};
    if (!b.title) bad('title required');
    const info = db.prepare('INSERT INTO tasks (venue_id,booking_id,title,detail,due_at,priority,status,auto,created_at) VALUES (?,?,?,?,?,?,?,0,?)')
      .run(b.venue_id || null, b.booking_id || null, b.title, b.detail || null, b.due_at || now(), b.priority || 'normal', 'open', now());
    return db.prepare('SELECT * FROM tasks WHERE id=?').get(info.lastInsertRowid);
  },
  'PATCH /api/tasks/:id': (ctx) => {
    const b = ctx.body || {};
    if (b.status === 'done') db.prepare("UPDATE tasks SET status='done', completed_at=? WHERE id=?").run(now(), ctx.params.id);
    else {
      const cols = ['title', 'detail', 'due_at', 'priority', 'status'].filter(f => b[f] !== undefined);
      if (cols.length) db.prepare(`UPDATE tasks SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => b[c]), ctx.params.id);
    }
    return db.prepare('SELECT * FROM tasks WHERE id=?').get(ctx.params.id);
  },
  'DELETE /api/tasks/:id': (ctx) => { db.prepare('DELETE FROM tasks WHERE id=?').run(ctx.params.id); return { ok: true }; },

  // ─── money ───────────────────────────────────────────────────────────────────
  'GET /api/finance': (ctx) => {
    const year = ctx.query.year || String(new Date().getFullYear());
    const rows = db.prepare(`SELECT b.*, v.name venue_name FROM bookings b LEFT JOIN venues v ON v.id=b.venue_id
      WHERE substr(b.date,1,4)=? ORDER BY b.date`).all(year);
    const expenses = db.prepare(`SELECT e.* FROM expenses e JOIN bookings b ON b.id=e.booking_id WHERE substr(b.date,1,4)=?`).all(year);
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: `${year}-${String(i + 1).padStart(2, '0')}`, booked: 0, played: 0, gross: 0, collected: 0, expenses: 0, gigs: 0,
    }));
    let gross = 0, collected = 0, outstanding = 0, depositsOwed = 0, pipeline = 0, expenseTotal = 0;
    for (const b of rows) {
      const m = months[parseInt(b.date.slice(5, 7), 10) - 1];
      if (!m) continue;
      const fee = num(b.fee), paid = num(b.paid);
      m.gigs++;
      if (b.status === 'played') { m.played++; m.gross += fee; m.collected += paid; gross += fee; collected += paid; outstanding += Math.max(0, fee - paid); }
      else if (b.status === 'confirmed') { m.booked++; m.gross += fee; m.collected += paid; gross += fee; collected += paid; outstanding += Math.max(0, fee - paid); if (!b.deposit_paid) depositsOwed += num(b.deposit); }
      else if (b.status === 'hold') pipeline += fee;
      m.expenses += num(b.travel_cost);
      expenseTotal += num(b.travel_cost);
    }
    for (const e of expenses) {
      const m = months.find(x => x.month === e.date.slice(0, 7));
      if (m) m.expenses += num(e.amount);
      expenseTotal += num(e.amount);
    }
    const played = rows.filter(b => b.status === 'played');
    const byVenue = {};
    for (const b of rows) {
      if (!b.venue_name) continue;
      byVenue[b.venue_name] ||= { venue: b.venue_name, gigs: 0, gross: 0, collected: 0 };
      if (['played', 'confirmed'].includes(b.status)) { byVenue[b.venue_name].gigs++; byVenue[b.venue_name].gross += num(b.fee); byVenue[b.venue_name].collected += num(b.paid); }
    }
    return {
      year, months,
      totals: {
        gross, collected, outstanding, depositsOwed, pipeline, expenses: expenseTotal,
        net: collected - expenseTotal,
        gigs: rows.length, playedGigs: played.length,
        avgFee: played.length ? played.reduce((s, b) => s + num(b.fee), 0) / played.length : 0,
      },
      topVenues: Object.values(byVenue).sort((a, b) => b.gross - a.gross).slice(0, 10),
      bookings: rows,
    };
  },

  'POST /api/expenses': (ctx) => {
    const b = ctx.body || {};
    if (!b.amount || !b.category) bad('category and amount required');
    const info = db.prepare('INSERT INTO expenses (booking_id,category,amount,date,note,created_at) VALUES (?,?,?,?,?,?)')
      .run(b.booking_id || null, b.category, num(b.amount), b.date || dateOnly(Date.now()), b.note || null, now());
    return db.prepare('SELECT * FROM expenses WHERE id=?').get(info.lastInsertRowid);
  },
  'GET /api/expenses': () => ({ expenses: db.prepare('SELECT * FROM expenses ORDER BY date DESC LIMIT 200').all() }),

  // ─── analytics ───────────────────────────────────────────────────────────────
  'GET /api/analytics': () => {
    const byStage = db.prepare('SELECT stage, COUNT(*) c, SUM(COALESCE(fee_target,0)) v FROM venues WHERE archived=0 GROUP BY stage').all();
    const byArea = db.prepare(`SELECT area_label label, state, COUNT(*) c,
        SUM(CASE WHEN email IS NOT NULL AND email <> '' THEN 1 ELSE 0 END) with_email,
        SUM(CASE WHEN stage IN ('booked','played','repeat') THEN 1 ELSE 0 END) won
      FROM venues WHERE archived=0 GROUP BY area_label, state ORDER BY c DESC`).all();
    const byType = db.prepare('SELECT venue_type type, COUNT(*) c FROM venues WHERE archived=0 GROUP BY venue_type ORDER BY c DESC').all();
    const activity = db.prepare(`SELECT substr(created_at,1,10) d, type, COUNT(*) c FROM activities
      WHERE created_at > ? GROUP BY d, type ORDER BY d`).all(new Date(Date.now() - 60 * 86400000).toISOString());
    const contacted = db.prepare("SELECT COUNT(*) c FROM venues WHERE archived=0 AND last_contacted_at IS NOT NULL").get().c;
    const replied = db.prepare("SELECT COUNT(DISTINCT venue_id) c FROM activities WHERE type='reply'").get().c;
    const booked = db.prepare("SELECT COUNT(*) c FROM venues WHERE stage IN ('booked','played','repeat')").get().c;
    const total = db.prepare('SELECT COUNT(*) c FROM venues WHERE archived=0').get().c;
    const map = db.prepare(`SELECT id,name,lat,lng,stage,capacity,score,city,state,venue_type,email,phone,
      (SELECT COALESCE(SUM(fee),0) FROM bookings b WHERE b.venue_id=venues.id AND b.status IN ('confirmed','played')) revenue
      FROM venues WHERE archived=0 AND lat IS NOT NULL`).all();
    return {
      byStage, byArea, byType, activity, map,
      funnel: [
        { label: 'In database', count: total },
        { label: 'Contacted', count: contacted },
        { label: 'Replied', count: replied },
        { label: 'Booked', count: booked },
      ],
      rates: {
        contactRate: total ? contacted / total : 0,
        replyRate: contacted ? replied / contacted : 0,
        bookRate: replied ? booked / replied : 0,
      },
    };
  },

  // ─── templates + automations ─────────────────────────────────────────────────
  'GET /api/templates': () => ({ templates: db.prepare('SELECT * FROM templates ORDER BY id').all() }),
  'POST /api/templates': (ctx) => {
    const b = ctx.body || {};
    if (!b.name || !b.body) bad('name and body required');
    const info = db.prepare('INSERT INTO templates (name,channel,subject,body,stage,created_at) VALUES (?,?,?,?,?,?)')
      .run(b.name, b.channel || 'email', b.subject || null, b.body, b.stage || null, now());
    return db.prepare('SELECT * FROM templates WHERE id=?').get(info.lastInsertRowid);
  },
  'PATCH /api/templates/:id': (ctx) => {
    const b = ctx.body || {};
    const cols = ['name', 'channel', 'subject', 'body', 'stage'].filter(f => b[f] !== undefined);
    if (cols.length) db.prepare(`UPDATE templates SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`).run(...cols.map(c => b[c]), ctx.params.id);
    return db.prepare('SELECT * FROM templates WHERE id=?').get(ctx.params.id);
  },
  'DELETE /api/templates/:id': (ctx) => { db.prepare('DELETE FROM templates WHERE id=?').run(ctx.params.id); return { ok: true }; },

  'POST /api/render': (ctx) => {
    const b = ctx.body || {};
    const t = b.template_id ? db.prepare('SELECT * FROM templates WHERE id=?').get(b.template_id) : null;
    if (!t) missing('template');
    const v = b.venue_id ? db.prepare('SELECT * FROM venues WHERE id=?').get(b.venue_id) : null;
    const bk = b.booking_id ? db.prepare('SELECT * FROM bookings WHERE id=?').get(b.booking_id) : null;
    const a = setting('artist') || {};
    const monthName = new Date(Date.now() + 30 * 86400000).toLocaleString('en-US', { month: 'long' });
    const firstName = (v?.contact_name || '').split(' ')[0];
    const vars = {
      venue: v?.name || '{{venue}}',
      city: v?.city || '', state: v?.state || '',
      contact: v?.contact_name || '',
      contact_first: firstName ? ' ' + firstName : '',
      email: v?.email || '', phone: v?.phone || '',
      artist: a.name || 'the artist', spotify: a.spotify || '', tiktok: a.tiktok || '', home_base: a.home_base || '',
      signature: a.signature || 'Management',
      month: monthName,
      date: bk?.date || '{{date}}',
      fee: bk?.fee ? `$${Math.round(bk.fee)}` : (a.base_fee ? `$${a.base_fee}` : '{{fee}}'),
      deposit: bk?.deposit ? `$${Math.round(bk.deposit)}` : '50%',
      set_length: bk?.set_length || 120,
    };
    const fill = (s) => (s || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
    return { subject: fill(t.subject), body: fill(t.body), channel: t.channel, to: v?.email || null };
  },

  'GET /api/automations': () => ({
    automations: db.prepare('SELECT * FROM automations ORDER BY id').all()
      .map(a => ({ ...a, params: parseJson(a.params, {}), action_params: parseJson(a.action_params, {}) })),
  }),
  'PATCH /api/automations/:id': (ctx) => {
    const b = ctx.body || {};
    if (b.enabled !== undefined) db.prepare('UPDATE automations SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, ctx.params.id);
    if (b.params) db.prepare('UPDATE automations SET params=? WHERE id=?').run(JSON.stringify(b.params), ctx.params.id);
    return db.prepare('SELECT * FROM automations WHERE id=?').get(ctx.params.id);
  },
  'POST /api/automations/run': () => runAutomations(),

  // ─── artist + settings ───────────────────────────────────────────────────────
  'GET /api/artist': () => setting('artist'),
  'PATCH /api/artist': (ctx) => setting('artist', { ...(setting('artist') || {}), ...(ctx.body || {}) }),

  'GET /api/feed': () => ({ events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 60').all() }),

  'POST /api/password': (ctx) => {
    const b = ctx.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.user.id);
    if (!checkPw(b.current || '', u.pw)) bad('current password is wrong');
    if (!b.next || b.next.length < 8) bad('new password must be 8+ characters');
    db.prepare('UPDATE users SET pw=? WHERE id=?').run(hashPw(b.next), u.id);
    return { ok: true };
  },
};

export function csvVenues(query) {
  const where = ['archived=0'], args = [];
  if (query.stage && query.stage !== 'all') { where.push('stage=?'); args.push(query.stage); }
  if (query.has === 'contact') where.push("((email IS NOT NULL AND email<>'') OR (phone IS NOT NULL AND phone<>''))");
  const rows = db.prepare(`SELECT name,venue_type,address,city,state,capacity,website,email,phone,instagram,stage,score
    FROM venues WHERE ${where.join(' AND ')} ORDER BY score DESC`).all(...args);
  const head = 'Name,Type,Address,City,State,Capacity,Website,Email,Phone,Instagram,Stage,Score';
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  return [head, ...rows.map(r => Object.values(r).map(esc).join(','))].join('\n');
}
