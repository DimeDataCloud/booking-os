// discover-cli.js — run a full sweep of config/areas.json + enrichment offline and write a seed file.
// Usage: node server/discover-cli.js [--enrich N] [--out data/seed-venues.json]
import { discover, enrich, scoreVenue, AREAS } from './leadgen.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const out = arg('--out', 'data/seed-venues.json');
const enrichCount = parseInt(arg('--enrich', '80'), 10);

console.log(`sweeping ${Object.keys(AREAS).length} areas…`);
const raw = await discover(null, { limit: 1200 });
const errors = raw.filter(v => v.__error);
const venues = raw.filter(v => !v.__error);
errors.forEach(e => console.log('  ! ' + e.__error));
console.log(`found ${venues.length} named venues`);

// Enrich the highest-potential ones first — a website is the precondition for enrichment.
venues.forEach(v => { const { score, reasons } = scoreVenue(v); v.score = score; v.score_reasons = reasons; });
const targets = venues.filter(v => v.website && !v.email).sort((a, b) => b.score - a.score).slice(0, enrichCount);
console.log(`enriching ${targets.length} venues with websites…`);

let done = 0;
const BATCH = 6;
for (let i = 0; i < targets.length; i += BATCH) {
  const slice = targets.slice(i, i + BATCH);
  await Promise.all(slice.map(async v => {
    try {
      const e = await enrich(v);
      if (e.emails.length) v.email = e.emails[0];
      v.emails_all = e.emails;
      if (!v.phone && e.phones.length) v.phone = e.phones[0];
      v.instagram ||= e.instagram;
      v.facebook = e.facebook || null;
      v.tiktok_handle = e.tiktok || null;
      v.enrich_note = e.notes;
      v.enriched_at = new Date().toISOString();
    } catch (err) { v.enrich_note = 'enrich failed: ' + err.message; }
    done++;
    if (done % 10 === 0) console.log(`  …${done}/${targets.length}`);
  }));
}

venues.forEach(v => { const { score, reasons } = scoreVenue(v); v.score = score; v.score_reasons = reasons; });
venues.sort((a, b) => b.score - a.score);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(venues, null, 1));
const withEmail = venues.filter(v => v.email).length;
const withPhone = venues.filter(v => v.phone).length;
console.log(`\nwrote ${out}`);
console.log(`${venues.length} venues · ${withEmail} with email · ${withPhone} with phone · ${venues.filter(v => v.website).length} with website`);
