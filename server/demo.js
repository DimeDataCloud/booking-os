// demo.js — fictional demo data so a fresh install has something to look at.
// Every venue, contact and address here is made up. Coordinates fall inside the
// example areas in config/areas.example.json so the 3D map has a real shape.
// Runs once, on an empty venues table, unless DEMO_SEED=0.

const NAMES = [
  'Lumen Halle', 'Northside Foundry', 'Kiosk Neun', 'Basement 44', 'Signal Room', 'Low Tide',
  'Glasshouse', 'Concrete Garden', 'Night Shift', 'Orbit Lounge', 'The Copper Room', 'Pulse Hall',
  'Echo Yard', 'Neon Depot', 'Halcyon', 'Afterglow', 'Substation', 'Riverside Dock',
  'Static Bar', 'Moss Club', 'Vault 7', 'Parallax', 'Meridian', 'The Annex',
];

// How a working pipeline tends to look: wide at the top, a few deals in flight.
const STAGE_MIX = [
  ['prospect', 8], ['researching', 3], ['contacted', 4], ['in_conversation', 3],
  ['negotiating', 2], ['booked', 1], ['played', 1], ['repeat', 1], ['passed', 1],
];

const TYPES = ['nightclub', 'nightclub', 'bar / lounge', 'events venue'];
const STREETS = ['Lindenweg', 'Hafenstrasse', 'Am Speicher', 'Glaserstrasse', 'Kanalufer', 'Werkhof'];

// Deterministic, so every fresh install looks the same.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

export function seedDemo(db, { AREAS, importVenues, now }) {
  const areaKeys = Object.keys(AREAS);
  if (!areaKeys.length) return;
  const r = rng(42);
  const stages = STAGE_MIX.flatMap(([s, n]) => Array(n).fill(s));

  const venues = NAMES.map((name, i) => {
    const key = areaKeys[i % areaKeys.length];
    const [s, w, n, e] = AREAS[key].bbox;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const hasEmail = r() > 0.35;
    return {
      osm_id: `demo-${i + 1}`,
      name,
      venue_type: TYPES[Math.floor(r() * TYPES.length)],
      address: `${10 + Math.floor(r() * 180)} ${STREETS[Math.floor(r() * STREETS.length)]}`,
      city: AREAS[key].city || AREAS[key].label,
      state: AREAS[key].state || null,
      area: key,
      area_label: AREAS[key].label,
      lat: s + r() * (n - s),
      lng: w + r() * (e - w),
      capacity: [150, 250, 400, 600, 900, 1500][Math.floor(r() * 6)],
      website: `https://${slug}.example`,
      email: hasEmail ? (r() > 0.5 ? `booking@${slug}.example` : `info@${slug}.example`) : null,
      instagram: r() > 0.3 ? slug.replace(/-/g, '') : null,
      source: 'demo',
    };
  });
  importVenues(venues);

  const setStage = db.prepare('UPDATE venues SET stage=?, last_contacted_at=? WHERE osm_id=?');
  venues.forEach((v, i) => {
    const contacted = stages[i] === 'prospect' ? null : daysFromNow(-(3 + Math.floor(r() * 20)));
    setStage.run(stages[i], contacted, v.osm_id);
  });

  // Bookings relative to today, so the calendar and money views are never stale.
  const id = (n) => db.prepare('SELECT id FROM venues WHERE osm_id=?').get(`demo-${n}`)?.id ?? null;
  const byStage = (stage) => venues.findIndex((_, i) => stages[i] === stage) + 1;
  const book = db.prepare(`INSERT INTO bookings
    (venue_id,title,date,start_time,end_time,status,fee,deposit,deposit_paid,paid,payout_status,set_length,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rows = [
    [byStage('booked'), 12, '23:00', '02:00', 'confirmed', 900, 450, 1, 450, 'partial', 180],
    [byStage('negotiating'), 26, '22:00', '00:00', 'hold', 750, 375, 0, 0, 'unpaid', 120],
    [byStage('repeat'), 5, '00:00', '04:00', 'confirmed', 1200, 600, 1, 600, 'partial', 240],
    [byStage('repeat'), -24, '00:00', '04:00', 'played', 1200, 600, 1, 1200, 'paid', 240],
    [byStage('played'), -18, '23:00', '01:00', 'played', 650, 0, 0, 0, 'unpaid', 120],
    [byStage('repeat'), -52, '23:00', '03:00', 'played', 1000, 500, 1, 1000, 'paid', 240],
  ];
  for (const [n, days, start, end, status, fee, dep, depPaid, paid, payout, len] of rows) {
    const venueId = id(n);
    const venue = venues[n - 1];
    book.run(venueId, venue.name, daysFromNow(days).slice(0, 10), start, end, status, fee, dep, depPaid,
      paid, payout, len, now(), now());
  }
}

function daysFromNow(d) {
  return new Date(Date.now() + d * 86400000).toISOString();
}
