// clean-contacts.js — one-off repair: drop contact values that the tightened
// extractor would never have produced, then re-enrich those venues.
// Usage: node server/clean-contacts.js [--reenrich N]
import { db, now } from './db.js';
import { sanitizeEmail, cleanPhone, enrich, scoreVenue } from './leadgen.js';

const argv = process.argv.slice(2);
const reenrich = parseInt((argv[argv.indexOf('--reenrich') + 1] || '0'), 10) || 0;

const rows = db.prepare('SELECT id,name,email,emails_all,phone,website FROM venues').all();
let droppedEmail = 0, droppedPhone = 0, trimmed = 0;

for (const v of rows) {
  const goodEmail = sanitizeEmail(v.email);
  const goodPhone = cleanPhone(v.phone);
  let all = [];
  try { all = JSON.parse(v.emails_all || '[]'); } catch {}
  const cleanAll = all.map(sanitizeEmail).filter(Boolean);
  if (cleanAll.length !== all.length) trimmed++;
  if (v.email && !goodEmail) droppedEmail++;
  if (v.phone && !goodPhone) droppedPhone++;
  const nextEmail = goodEmail || cleanAll[0] || null;
  db.prepare('UPDATE venues SET email=?, phone=?, emails_all=?, updated_at=? WHERE id=?')
    .run(nextEmail, goodPhone, JSON.stringify(cleanAll), now(), v.id);
}
console.log(`scrubbed ${rows.length} venues — dropped ${droppedEmail} bad emails, ${droppedPhone} bad phones, trimmed ${trimmed} lists`);

// Rescore, since contact fields feed the score.
for (const v of db.prepare('SELECT * FROM venues').all()) {
  const { score, reasons } = scoreVenue(v);
  db.prepare('UPDATE venues SET score=?, score_reasons=? WHERE id=?').run(score, JSON.stringify(reasons), v.id);
}

if (reenrich) {
  const targets = db.prepare(`SELECT * FROM venues WHERE website IS NOT NULL AND website <> ''
    AND (email IS NULL OR email = '') ORDER BY score DESC LIMIT ?`).all(reenrich);
  console.log(`re-enriching ${targets.length}…`);
  let found = 0;
  for (let i = 0; i < targets.length; i += 6) {
    await Promise.all(targets.slice(i, i + 6).map(async v => {
      try {
        const r = await enrich(v);
        db.prepare(`UPDATE venues SET email=COALESCE(NULLIF(email,''),?), emails_all=?, phone=COALESCE(NULLIF(phone,''),?),
          instagram=COALESCE(NULLIF(instagram,''),?), facebook=COALESCE(NULLIF(facebook,''),?), enrich_note=?, enriched_at=?, updated_at=? WHERE id=?`)
          .run(r.emails[0] || null, JSON.stringify(r.emails), r.phones[0] || null, r.instagram, r.facebook, r.notes, now(), now(), v.id);
        if (r.emails.length) found++;
      } catch {}
    }));
    if (i % 30 === 0) console.log(`  …${i}/${targets.length}`);
  }
  for (const v of db.prepare('SELECT * FROM venues').all()) {
    const { score, reasons } = scoreVenue(v);
    db.prepare('UPDATE venues SET score=?, score_reasons=? WHERE id=?').run(score, JSON.stringify(reasons), v.id);
  }
  console.log(`re-enrich found ${found} new emails`);
}

const s = db.prepare("SELECT COUNT(*) c, SUM(CASE WHEN email IS NOT NULL AND email<>'' THEN 1 ELSE 0 END) e, SUM(CASE WHEN phone IS NOT NULL AND phone<>'' THEN 1 ELSE 0 END) p FROM venues").get();
console.log(`now: ${s.c} venues · ${s.e} with email · ${s.p} with phone`);
