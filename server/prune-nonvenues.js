// prune-nonvenues.js — archive rows that the tightened discovery filter would never
// have imported: dance schools, studios, fitness spaces. Archived, not deleted, so a
// wrong call is recoverable from the Venues list with `archived=1`.
import { db, now } from './db.js';

const NOT_A_GIG_VENUE = /\b(studio|school|academy|conservatory|ballet|lessons?|classes|fitness|gym|zumba|barre|pilates|yoga|instruction|training|kids|children)\b/i;

const rows = db.prepare("SELECT id, name, venue_type, stage FROM venues WHERE archived = 0").all();
const hits = rows.filter(v =>
  NOT_A_GIG_VENUE.test(v.name) && !/nightclub|bar \/ lounge/.test(v.venue_type || ''));

const keep = hits.filter(v => v.stage !== 'prospect');   // never touch something being worked
const drop = hits.filter(v => v.stage === 'prospect');

for (const v of drop) db.prepare('UPDATE venues SET archived=1, updated_at=? WHERE id=?').run(now(), v.id);

console.log(`archived ${drop.length} non-venues:`);
console.log('  ' + drop.slice(0, 25).map(v => v.name).join(', ') + (drop.length > 25 ? ` … +${drop.length - 25}` : ''));
if (keep.length) console.log(`left ${keep.length} alone (already in the pipeline): ${keep.map(v => v.name).join(', ')}`);
const s = db.prepare("SELECT COUNT(*) c, SUM(CASE WHEN email IS NOT NULL AND email<>'' THEN 1 ELSE 0 END) e FROM venues WHERE archived=0").get();
console.log(`now: ${s.c} active venues · ${s.e} with email`);
