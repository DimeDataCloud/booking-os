import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// leadgen.js — club/venue discovery for your configured areas + contact enrichment.
//
// Two stages, deliberately separate:
//   discover()  — OpenStreetMap Overpass. Free, no key, returns name/geo/website/phone.
//   enrich(v)   — fetch the venue's own site, pull booking emails, phones, socials.
//
// Nothing here invents a contact. If a page can't be read, the field stays null and
// the venue is flagged `needs_research` instead of getting a plausible-looking guess.

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// The areas to sweep, from config/areas.json (falls back to the example file).
// Each one: { label, bbox: [south, west, north, east], state?, city? }.
const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'config');
function loadAreas() {
  for (const f of ['areas.json', 'areas.example.json']) {
    const p = join(CONFIG_DIR, f);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  return {};
}
export const AREAS = loadAreas();

// Two queries, deliberately. The first is all indexed value-matches and is cheap enough
// that Overpass never refuses it — those are the dance-floor venues, the ones that matter.
// The second filters on the *presence* of a key (`["website"]`), which is the expensive
// shape that gets a heavy request throttled or 504'd. Splitting them means a refused bar
// query costs us bars, not the whole area.
function coreQuery(bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:60];
(
  nwr["amenity"="nightclub"](${b});
  nwr["leisure"="dance"](${b});
  nwr["amenity"="events_venue"](${b});
  nwr["club"="music"](${b});
  nwr["amenity"="bar"]["live_music"="yes"](${b});
  nwr["amenity"="bar"]["dancing"="yes"](${b});
  nwr["amenity"="pub"]["live_music"="yes"](${b});
  nwr["amenity"="restaurant"]["nightclub"="yes"](${b});
);
out center tags;`;
}
function barQuery(bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:60];
(
  nwr["amenity"="bar"]["website"](${b});
  nwr["amenity"="pub"]["website"](${b});
);
out center tags;`;
}

// Every public Overpass mirror is busy some of the time; a 504 means "come back",
// not "this area is empty". One full retry of the mirror list after a pause turns
// most transient failures into results instead of a hole in the map.
async function postOverpass(query, attempt = 0) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'dj-booking-os/1.0 (booking research)' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) { lastErr = new Error(`${url} -> ${res.status}`); continue; }
      const json = await res.json();
      if (!json || !Array.isArray(json.elements)) { lastErr = new Error(`${url} -> malformed`); continue; }
      return json.elements;
    } catch (e) { lastErr = e; }
  }
  if (attempt < 1) {
    await new Promise(r => setTimeout(r, 25000));
    return postOverpass(query, attempt + 1);
  }
  throw lastErr || new Error('all Overpass mirrors failed');
}

// `leisure=dance` covers ballrooms and salsa clubs — and also every dance school in the
// city. A studio that teaches ballet on Tuesday afternoons is not a lead for a house DJ,
// and 100 of them buried in the list is how a lead list stops getting opened.
const NOT_A_GIG_VENUE = /\b(studio|school|academy|conservatory|ballet|lessons?|classes|fitness|gym|zumba|barre|pilates|yoga|instruction|training|kids|children)\b/i;
function isTeachingSpace(t) {
  if (t.amenity === 'nightclub' || t.amenity === 'bar' || t.amenity === 'pub') return false;
  if (t['dance:teaching'] === 'yes' || t.school === 'dance') return true;
  return NOT_A_GIG_VENUE.test(t.name || '');
}

const VENUE_TYPE = (t) => {
  if (t.amenity === 'nightclub') return 'nightclub';
  if (t.leisure === 'dance') return 'dance hall';
  if (t.amenity === 'events_venue') return 'event space';
  if (t.club === 'music') return 'music club';
  if (t.amenity === 'bar' || t.amenity === 'pub') return 'bar / lounge';
  if (t.amenity === 'restaurant') return 'restaurant club';
  return 'venue';
};

// Capacity is rarely tagged. Estimate a band from what OSM does carry so the
// pipeline can sort by size — always flagged as an estimate downstream.
function estimateCapacity(t) {
  const explicit = parseInt(t.capacity || t['capacity:persons'] || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return { capacity: explicit, estimated: 0 };
  const type = VENUE_TYPE(t);
  const guess = { 'nightclub': 400, 'dance hall': 300, 'event space': 500, 'music club': 250, 'bar / lounge': 120, 'restaurant club': 150, 'venue': 200 }[type];
  return { capacity: guess, estimated: 1 };
}

export function cleanPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (d.length !== 10) return null;
  const area = d.slice(0, 3), exch = d.slice(3, 6), line = d.slice(6);
  if (area[0] === '0' || area[0] === '1') return null;      // no such area code
  if (exch[0] === '0' || exch[0] === '1') return null;      // no such exchange
  if (area.slice(1) === '11') return null;                  // 211/311/…/911 aren't numbers
  if (exch === '555' && line.startsWith('01')) return null;  // reserved fiction range
  if (/^(\d)\1{9}$/.test(d)) return null;                   // 0000000000 style filler
  return `(${area}) ${exch}-${line}`;
}

function normUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const url = new URL(s); return url.origin + (url.pathname === '/' ? '' : url.pathname); } catch { return null; }
}

function stateFor(el, areaKey) {
  const t = el.tags || {};
  const s = t['addr:state'];
  if (s) return s.toUpperCase().slice(0, 2);
  return AREAS[areaKey]?.state || null;
}

export async function discover(areaKeys, { limit = 400, perArea = 140 } = {}) {
  const keys = (areaKeys && areaKeys.length ? areaKeys : Object.keys(AREAS)).filter(k => AREAS[k]);
  const out = [];
  const seen = new Set();
  for (const key of keys) {
    const area = AREAS[key];
    let elements;
    try {
      elements = await postOverpass(coreQuery(area.bbox));
    } catch (e) {
      out.push({ __error: `${area.label}: ${e.message}` });
      continue;
    }
    // Best-effort. Losing the bar sweep is a smaller list, not a failed area.
    try {
      elements = elements.concat(await postOverpass(barQuery(area.bbox)));
    } catch (e) {
      out.push({ __error: `${area.label} (bars only, clubs are in): ${e.message}` });
    }
    // Dance-floor venues before bars, so a per-area cap never spends itself on pubs.
    const rank = (el) => { const t = el.tags || {}; return t.amenity === 'nightclub' || t.leisure === 'dance' || t.club === 'music' ? 0 : (t.amenity === 'events_venue' ? 1 : 2); };
    elements = elements.slice().sort((a, b) => rank(a) - rank(b));
    let areaCount = 0;
    for (const el of elements) {
      if (areaCount >= perArea) break;
      const t = el.tags || {};
      const name = (t.name || '').trim();
      if (!name) continue;                       // an unnamed node is not a lead
      if (isTeachingSpace(t)) continue;
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) continue;
      const dedupe = name.toLowerCase() + '|' + lat.toFixed(3) + '|' + lng.toFixed(3);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const { capacity, estimated } = estimateCapacity(t);
      const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
      out.push({
        osm_id: `${el.type}/${el.id}`,
        name,
        venue_type: VENUE_TYPE(t),
        address: addr || null,
        city: t['addr:city'] || area.label,
        state: stateFor(el, key),
        zip: t['addr:postcode'] || null,
        area: key,
        area_label: area.label,
        lat, lng,
        capacity,
        capacity_estimated: estimated,
        website: normUrl(t.website || t['contact:website'] || t.url),
        phone: cleanPhone(t.phone || t['contact:phone']),
        email: sanitizeEmail(t.email || t['contact:email']),
        instagram: (t['contact:instagram'] || '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/$/, '') || null,
        opening_hours: t.opening_hours || null,
        source: 'openstreetmap',
      });
      areaCount++;
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ─── enrichment ────────────────────────────────────────────────────────────────

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
// A bare ten-digit run matches minified JS, tracking ids and CSS as happily as a phone
// number. Requiring real separators (or a tel: link) is what keeps garbage out.
const PHONE_RE = /(?:\+?1[\s.\-–]?)?(?:\((2[0-9]{2}|[3-9][0-9]{2})\)|\b(2[0-9]{2}|[3-9][0-9]{2}))[\s.\-–]{1,2}([2-9]\d{2})[\s.\-–]{1,2}(\d{4})\b/g;
const JUNK_EMAIL = /(example\.|sentry|wixpress|\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|godaddy|domain(s)?\.com|squarespace|wordpress|placeholder|yourname|yourdomain|@email\.com|@domain\.|^(you|your|name|firstname|user|username|someone|test)@|\.wixpress|cloudflare|@sentry|@2x|@3x)/i;
// Booking-relevant local parts, most useful first — this ordering is the whole point.
const PRIORITY = ['booking', 'talent', 'bookings', 'events', 'entertainment', 'promo', 'gm', 'manager', 'management', 'marketing', 'info', 'hello', 'contact'];

// mailto: values arrive percent-encoded and sometimes with leading whitespace encoded
// as %20 — decode before anything looks at them, or "%20booking@club.com" ships as-is.
function cleanEmail(raw) {
  let s = String(raw || '').trim();
  try { s = decodeURIComponent(s); } catch { /* keep the raw form if it isn't valid encoding */ }
  s = s.replace(/^[\s<>"'(,;:]+|[\s<>"'),;:.]+$/g, '').toLowerCase();
  const m = s.match(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/);
  return m ? s : null;
}

// One place that decides whether a string is a usable address — used by the scraper,
// the OSM importer, and the cleanup pass, so they can never disagree.
export function sanitizeEmail(raw) {
  const e = cleanEmail(raw);
  return e && !JUNK_EMAIL.test(e) ? e : null;
}

export function rankEmails(list) {
  const uniq = [...new Set(list.map(cleanEmail).filter(Boolean))].filter(e => !JUNK_EMAIL.test(e));
  return uniq.sort((a, b) => {
    const ai = PRIORITY.findIndex(p => a.split('@')[0].includes(p));
    const bi = PRIORITY.findIndex(p => b.split('@')[0].includes(p));
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

async function getPage(url, ms = 15000) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ms),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { ok: false, status: res.status, html: '' };
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return { ok: false, status: res.status, html: '' };
    const html = (await res.text()).slice(0, 900000);
    return { ok: true, status: res.status, html, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, html: '', error: e.message };
  }
}

function socialsFrom(html) {
  const grab = (re) => { const m = html.match(re); return m ? m[1].replace(/\/$/, '') : null; };
  return {
    instagram: grab(/instagram\.com\/([A-Za-z0-9_.]{2,40})/i),
    facebook: grab(/facebook\.com\/([A-Za-z0-9_.\-]{2,60})/i),
    tiktok: grab(/tiktok\.com\/@([A-Za-z0-9_.]{2,40})/i),
  };
}

// Contact info hides on /contact and /booking far more often than on the homepage.
const SUBPAGES = ['/contact', '/contact-us', '/booking', '/bookings', '/private-events', '/events', '/about'];

export async function enrich(venue) {
  const result = { emails: [], phones: [], instagram: null, facebook: null, tiktok: null, readable: false, checked: [], notes: null };
  const base = normUrl(venue.website);
  if (!base) { result.notes = 'no website on file'; return result; }
  let origin;
  try { origin = new URL(base).origin; } catch { result.notes = 'unparseable website'; return result; }

  const pages = [base, ...SUBPAGES.map(p => origin + p)];
  const emails = [], phones = [];
  for (const url of pages) {
    const page = await getPage(url);
    result.checked.push({ url, status: page.status });
    if (!page.ok || !page.html) continue;
    result.readable = true;
    const html = page.html;
    // mailto: first — an author-declared address beats one scraped out of body text.
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) emails.push(m[1]);
    for (const m of html.matchAll(EMAIL_RE)) emails.push(m[0]);
    for (const m of html.matchAll(/tel:\+?([\d\s().-]{10,20})/gi)) phones.push(m[1]);
    for (const m of html.matchAll(PHONE_RE)) phones.push(m[0]);
    const s = socialsFrom(html);
    result.instagram ||= s.instagram; result.facebook ||= s.facebook; result.tiktok ||= s.tiktok;
    if (emails.length >= 6) break;               // enough to rank; stop burning requests
  }
  result.emails = rankEmails(emails).slice(0, 6);
  result.phones = [...new Set(phones.map(cleanPhone).filter(Boolean))].slice(0, 4);
  if (!result.readable) result.notes = 'site unreadable (403 / JS shell / down) — contact not assessed';
  else if (!result.emails.length && !result.phones.length) result.notes = 'site read, no contact published — try Instagram DM';
  return result;
}

// A lead score a booking agent would actually accept: reachable, right size, right type.
// A booking agent's ranking, not a generic lead score: can I reach the person who books
// talent, is the room the right size, and does it have a dance floor at all. An address
// at booking@ outranks info@ by more than a phone number is worth — that's the point.
const BOOKING_ROLE = /^(booking|bookings|talent|events|entertainment|promo|gm|manager|management)/;

export function scoreVenue(v) {
  let s = 0;
  const reasons = [];
  const local = (v.email || '').split('@')[0];
  if (v.email && BOOKING_ROLE.test(local)) { s += 34; reasons.push(`${local}@ — books talent`); }
  else if (v.email) { s += 24; reasons.push('email on file'); }
  else if (v.phone) { s += 12; reasons.push('phone only'); }
  if (v.phone) { s += 10; reasons.push('phone'); }
  if (v.instagram) { s += 8; reasons.push('instagram'); }
  if (v.website) { s += 8; reasons.push('website'); }
  const cap = v.capacity || 0;
  if (cap >= 500) { s += 22; reasons.push('500+ room'); }
  else if (cap >= 300) { s += 18; reasons.push('300+ room'); }
  else if (cap >= 150) { s += 12; reasons.push('mid-size room'); }
  else if (cap > 0) { s += 6; reasons.push('small room'); }
  if (/nightclub|dance hall|music club/.test(v.venue_type || '')) { s += 18; reasons.push('dance-floor venue'); }
  else if (/event space/.test(v.venue_type || '')) { s += 10; reasons.push('event space'); }
  else { s += 4; }
  return { score: Math.min(100, s), reasons };
}
