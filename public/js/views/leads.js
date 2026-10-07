// leads.js — the venue table + the lead generator.
import { api, state, esc, stagePill, scoreTag, toast, openModal, closeOverlays, field, selectHtml, ago } from '../core.js';
import { openVenue, onVenueChange } from '../venue.js';

let listEl;

export async function mount(view) {
  document.getElementById('topActions').innerHTML = `
    <button class="btn" id="export">Export CSV</button>
    <button class="btn primary" id="gen">⚡ Find venues</button>`;
  document.getElementById('gen').onclick = leadgenModal;
  document.getElementById('export').onclick = () => { window.location = '/api/export/venues.csv?stage=' + state.filters.stage; };

  view.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="row" style="gap:8px">
        <input type="text" id="q" placeholder="Search name, city, email, notes…" style="flex:1;min-width:180px" value="${esc(state.filters.q)}">
        ${selectHtml('sort', [{ value: 'score', label: 'Best leads first' }, { value: 'capacity', label: 'Biggest room' }, { value: 'name', label: 'A–Z' }, { value: 'recent', label: 'Recently touched' }], state.filters.sort, 'style="width:auto"')}
      </div>
      <div class="chips" style="margin-top:10px">
        <button class="chip ${state.filters.has === 'all' ? 'on' : ''}" data-has="all">All</button>
        <button class="chip ${state.filters.has === 'contact' ? 'on' : ''}" data-has="contact">Contactable</button>
        <button class="chip ${state.filters.has === 'email' ? 'on' : ''}" data-has="email">Has email</button>
        <button class="chip ${state.filters.has === 'phone' ? 'on' : ''}" data-has="phone">Has phone</button>
      </div>
      <div class="chips" style="margin-top:8px">
        <button class="chip ${state.filters.stage === 'all' ? 'on' : ''}" data-stage="all">Every stage</button>
        ${state.stages.map(s => `<button class="chip ${state.filters.stage === s.key ? 'on' : ''}" data-stage="${s.key}">${esc(s.label)}</button>`).join('')}
      </div>
      <div class="chips" style="margin-top:8px">
        <button class="chip ${state.filters.area === 'all' ? 'on' : ''}" data-area="all">All areas</button>
        ${state.areas.map(a => `<button class="chip ${state.filters.area === a.key ? 'on' : ''}" data-area="${a.key}">${esc(a.label)}</button>`).join('')}
      </div>
    </div>
    <div class="card pad0"><div id="list"><div class="empty"><span class="spin"></span></div></div></div>`;

  listEl = view.querySelector('#list');
  const q = view.querySelector('#q');
  let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.filters.q = q.value; load(); }, 220); };
  view.querySelector('#sort').onchange = (e) => { state.filters.sort = e.target.value; load(); };
  view.querySelectorAll('[data-has]').forEach(b => b.onclick = () => { state.filters.has = b.dataset.has; refreshChips(view); load(); });
  view.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => { state.filters.stage = b.dataset.stage; refreshChips(view); load(); });
  view.querySelectorAll('[data-area]').forEach(b => b.onclick = () => { state.filters.area = b.dataset.area; refreshChips(view); load(); });

  onVenueChange(load);
  await load();
}

function refreshChips(view) {
  view.querySelectorAll('[data-has]').forEach(b => b.classList.toggle('on', b.dataset.has === state.filters.has));
  view.querySelectorAll('[data-stage]').forEach(b => b.classList.toggle('on', b.dataset.stage === state.filters.stage));
  view.querySelectorAll('[data-area]').forEach(b => b.classList.toggle('on', b.dataset.area === state.filters.area));
}

async function load() {
  const f = state.filters;
  const qs = new URLSearchParams({ stage: f.stage, area: f.area, sort: f.sort, limit: '400' });
  if (f.has !== 'all') qs.set('has', f.has);
  if (f.q) qs.set('q', f.q);
  const { venues, total } = await api('/api/venues?' + qs);
  state.venues = venues;
  state.venueTotal = total;
  document.getElementById('subtitle').textContent = `${venues.length} shown of ${total}`;
  if (!venues.length) { listEl.innerHTML = '<div class="empty">Nothing matches. Loosen the filters, or run the lead generator.</div>'; return; }
  listEl.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Venue</th><th>Where</th><th>Contact</th><th>Stage</th><th style="text-align:right">Score</th><th></th></tr></thead>
    <tbody>${venues.map(v => `<tr data-id="${v.id}">
      <td><b>${esc(v.name)}</b><div class="dim" style="font-size:11.5px">${esc(v.venue_type || '')}${v.capacity ? ` · ~${v.capacity}` : ''}</div></td>
      <td class="muted" style="font-size:12.5px">${esc(v.city || '')}${v.state ? ', ' + esc(v.state) : ''}</td>
      <td style="font-size:12px">${v.email ? `<div style="color:var(--cyan)">${esc(v.email.slice(0, 28))}</div>` : ''}${v.phone ? `<div class="mono dim">${esc(v.phone)}</div>` : ''}${!v.email && !v.phone ? '<span class="dim">—</span>' : ''}</td>
      <td>${stagePill(v.stage)}</td>
      <td style="text-align:right">${scoreTag(v.score)}</td>
      <td class="dim" style="font-size:11px;text-align:right">${v.last_contacted_at ? esc(ago(v.last_contacted_at)) : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
  listEl.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openVenue(tr.dataset.id));
}

function leadgenModal() {
  openModal(`
    <header><h2>Find venues</h2><button class="x" data-close>×</button></header>
    <div class="body">
      <p class="muted" style="font-size:13px;margin-bottom:14px">
        Sweeps OpenStreetMap for nightclubs, dance halls, event spaces and music bars, then reads each
        venue's own website for booking emails and phone numbers. New venues land in <b>Prospect</b>;
        anything already in the list keeps its stage.
      </p>
      <div class="chips" style="flex-wrap:wrap;margin-bottom:14px" id="areaPick">
        <button class="chip on" data-a="all">Everywhere</button>
        ${state.areas.map(a => `<button class="chip" data-a="${a.key}">${esc(a.label)}</button>`).join('')}
      </div>
      <label class="row" style="gap:8px;margin-bottom:8px"><input type="checkbox" id="doEnrich" checked style="width:auto"> <span>Also hunt for contact details (slower, ~1 min)</span></label>
      <div class="dim" style="font-size:11.5px">Runs on the server. You can close this window — it keeps going.</div>
    </div>
    <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="run">Run sweep</button></div>
  `, (m) => {
    const picks = new Set(['all']);
    m.querySelectorAll('#areaPick .chip').forEach(c => c.onclick = () => {
      const a = c.dataset.a;
      if (a === 'all') { picks.clear(); picks.add('all'); }
      else { picks.delete('all'); picks.has(a) ? picks.delete(a) : picks.add(a); if (!picks.size) picks.add('all'); }
      m.querySelectorAll('#areaPick .chip').forEach(x => x.classList.toggle('on', picks.has(x.dataset.a)));
    });
    m.querySelector('#run').onclick = async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> sweeping…';
      const areas = picks.has('all') ? [] : [...picks];
      try {
        const r = await api('/api/leadgen/run', { method: 'POST', body: { areas, enrich: m.querySelector('#doEnrich').checked, enrichLimit: 30 } });
        closeOverlays();
        toast(`${r.added} new venues · ${r.updated} updated · ${r.enriched} contacts found`);
        if (r.errors?.length) toast(r.errors[0], 'warn');
        load();
      } catch (err) { toast(err.message, 'err'); e.target.disabled = false; e.target.textContent = 'Run sweep'; }
    };
  });
}
