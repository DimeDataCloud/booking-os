// venue.js — the venue drawer. Every view opens the same one.
import { api, state, esc, money, ago, dateLabel, stagePill, scoreTag, openDrawer, openModal, closeOverlays, toast, field, selectHtml } from './core.js';

let onChangeCb = null;
export function onVenueChange(cb) { onChangeCb = cb; }
const fire = () => { if (onChangeCb) onChangeCb(); };

const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:var(--cyan)">${esc(label)}</a>`;

export async function openVenue(id) {
  openDrawer(`<header><h2>Loading…</h2><button class="x" data-close>×</button></header><div class="body"><span class="spin"></span></div>`);
  let data;
  try { data = await api('/api/venues/' + id); }
  catch (e) { return toast(e.message, 'err'); }
  const { venue: v, activities, bookings, tasks } = data;

  const contactBits = [
    v.email ? `<div>✉ ${link('mailto:' + v.email, v.email)}</div>` : '',
    v.phone ? `<div>☎ ${link('tel:' + v.phone.replace(/[^\d+]/g, ''), v.phone)}</div>` : '',
    v.website ? `<div>⌘ ${link(v.website, v.website.replace(/^https?:\/\//, '').slice(0, 42))}</div>` : '',
    v.instagram ? `<div>◎ ${link('https://instagram.com/' + v.instagram, '@' + v.instagram)}</div>` : '',
  ].filter(Boolean).join('');

  const alt = (v.emails_all || []).filter(e => e !== v.email);

  openDrawer(`
    <header>
      <div>
        <h2>${esc(v.name)}</h2>
        <div class="sub muted" style="font-size:12.5px;margin-top:3px">
          ${esc(v.venue_type || 'venue')} · ${esc([v.city, v.state].filter(Boolean).join(', '))}
          ${v.capacity ? ` · ~${v.capacity} cap${v.capacity_estimated ? ' (est)' : ''}` : ''}
        </div>
        <div style="margin-top:8px" class="row">${stagePill(v.stage)} ${scoreTag(v.score)}</div>
      </div>
      <button class="x" data-close>×</button>
    </header>
    <div class="body">
      <div class="card" style="margin-bottom:14px">
        <h3>Contact</h3>
        ${contactBits || '<div class="dim" style="font-size:12.5px">No contact on file.</div>'}
        ${alt.length ? `<div class="dim" style="font-size:11.5px;margin-top:8px">Also found: ${alt.map(esc).join(', ')}</div>` : ''}
        ${v.enrich_note ? `<div class="dim" style="font-size:11.5px;margin-top:8px">${esc(v.enrich_note)}</div>` : ''}
        <div class="row" style="margin-top:11px">
          <button class="btn sm" id="enrich">Find contacts</button>
          ${v.email ? `<button class="btn sm" id="compose">Compose email</button>` : ''}
          ${v.phone ? `<a class="btn sm" href="tel:${esc(v.phone.replace(/[^\d+]/g, ''))}">Call</a>` : ''}
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3>Pipeline</h3>
        ${field('Stage', selectHtml('stage', state.stages.map(s => ({ value: s.key, label: s.label })), v.stage))}
        <div class="grid2">
          ${field('Contact name', `<input type="text" id="contact_name" value="${esc(v.contact_name || '')}" placeholder="Talent buyer">`)}
          ${field('Target fee', `<input type="number" id="fee_target" value="${v.fee_target ?? ''}" placeholder="${state.artist?.base_fee || 750}">`)}
        </div>
        ${field('Notes', `<textarea id="notes" placeholder="Door split? Resident nights? Who answers the DMs?">${esc(v.notes || '')}</textarea>`)}
        <button class="btn primary sm" id="save">Save</button>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3>Log a touch</h3>
        <div class="row">
          ${['email', 'call', 'dm', 'text', 'reply', 'note'].map(t => `<button class="btn sm" data-log="${t}">${t}</button>`).join('')}
        </div>
      </div>

      ${bookings.length ? `<div class="card" style="margin-bottom:14px"><h3>Bookings</h3>${bookings.map(b => `
        <div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
          <span>${esc(dateLabel(b.date))} · ${esc(b.status)}</span><span class="mono">${money(b.fee)}</span>
        </div>`).join('')}</div>` : ''}

      ${tasks.length ? `<div class="card" style="margin-bottom:14px"><h3>Open tasks</h3>${tasks.map(t => `
        <div class="row" style="gap:8px;padding:5px 0"><button class="btn sm" data-done="${t.id}">✓</button><span style="font-size:12.5px">${esc(t.title)}</span></div>`).join('')}</div>` : ''}

      <div class="card">
        <h3>History</h3>
        ${activities.length ? `<div class="tl">${activities.map(a => `
          <div class="tl-item">
            <div class="h">${esc(a.type)}${a.subject ? ' — ' + esc(a.subject) : ''}</div>
            <div class="t">${esc(ago(a.created_at))} · ${esc(a.actor || 'system')}</div>
            ${a.body ? `<div class="b">${esc(a.body.slice(0, 400))}</div>` : ''}
          </div>`).join('')}</div>` : '<div class="dim" style="font-size:12.5px">Nothing logged yet.</div>'}
      </div>
    </div>
    <div class="foot">
      <button class="btn primary" id="book">Add booking</button>
      <button class="btn" id="archive">Archive</button>
    </div>
  `, (d) => {
    d.querySelector('#save').onclick = async () => {
      const body = {
        stage: d.querySelector('#stage').value,
        contact_name: d.querySelector('#contact_name').value || null,
        fee_target: parseFloat(d.querySelector('#fee_target').value) || null,
        notes: d.querySelector('#notes').value || null,
      };
      await api('/api/venues/' + v.id, { method: 'PATCH', body });
      toast('Saved');
      fire(); openVenue(v.id);
    };
    d.querySelector('#enrich').onclick = async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> searching';
      try {
        const r = await api(`/api/venues/${v.id}/enrich`, { method: 'POST' });
        toast(r.result.emails.length ? `Found ${r.result.emails.length} email(s)` : (r.result.notes || 'No contact found'), r.result.emails.length ? '' : 'warn');
        fire(); openVenue(v.id);
      } catch (err) { toast(err.message, 'err'); e.target.disabled = false; e.target.textContent = 'Find contacts'; }
    };
    d.querySelectorAll('[data-log]').forEach(b => b.onclick = () => logTouch(v, b.dataset.log));
    d.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
      await api('/api/tasks/' + b.dataset.done, { method: 'PATCH', body: { status: 'done' } });
      toast('Task done'); fire(); openVenue(v.id);
    });
    const comp = d.querySelector('#compose');
    if (comp) comp.onclick = () => composeFor(v);
    d.querySelector('#book').onclick = () => bookingModal({ venue_id: v.id, venue_name: v.name }, () => { fire(); openVenue(v.id); });
    d.querySelector('#archive').onclick = async () => {
      await api('/api/venues/' + v.id, { method: 'DELETE' });
      toast('Archived'); closeOverlays(); fire();
    };
  });
}

function logTouch(v, type) {
  openModal(`
    <header><h2>Log ${esc(type)} — ${esc(v.name)}</h2><button class="x" data-close>×</button></header>
    <div class="body">
      ${field('Subject', `<input type="text" id="subject" placeholder="${type === 'reply' ? 'What did they say?' : 'What was it about?'}">`)}
      ${field('Detail', `<textarea id="body" placeholder="Optional"></textarea>`)}
    </div>
    <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Log it</button></div>
  `, (m) => {
    m.querySelector('#ok').onclick = async () => {
      await api(`/api/venues/${v.id}/activity`, { method: 'POST', body: { type, subject: m.querySelector('#subject').value || null, body: m.querySelector('#body').value || null, channel: type } });
      closeOverlays(); toast('Logged'); fire(); openVenue(v.id);
    };
  });
}

export async function composeFor(v) {
  const { templates } = await api('/api/templates');
  const list = templates.filter(t => t.channel === 'email' || t.channel === 'instagram');
  openModal(`
    <header><h2>Compose — ${esc(v.name)}</h2><button class="x" data-close>×</button></header>
    <div class="body">
      ${field('Template', selectHtml('tpl', list.map(t => ({ value: t.id, label: `${t.name} (${t.channel})` })), list[0]?.id))}
      ${field('Subject', `<input type="text" id="subj">`)}
      ${field('Message', `<textarea id="msg" style="min-height:220px"></textarea>`)}
      <div class="dim" style="font-size:11.5px">Sending happens in your own mail app — this drafts it and logs the touch.</div>
    </div>
    <div class="foot">
      <button class="btn" id="copy">Copy</button>
      <button class="btn primary" id="send">Open in mail + log</button>
    </div>
  `, async (m) => {
    const load = async () => {
      const r = await api('/api/render', { method: 'POST', body: { template_id: parseInt(m.querySelector('#tpl').value, 10), venue_id: v.id } });
      m.querySelector('#subj').value = r.subject || '';
      m.querySelector('#msg').value = r.body || '';
    };
    m.querySelector('#tpl').onchange = load;
    await load();
    m.querySelector('#copy').onclick = () => {
      navigator.clipboard.writeText(m.querySelector('#msg').value).then(() => toast('Copied'));
    };
    m.querySelector('#send').onclick = async () => {
      const subject = m.querySelector('#subj').value, body = m.querySelector('#msg').value;
      if (v.email) window.open(`mailto:${v.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
      await api(`/api/venues/${v.id}/activity`, { method: 'POST', body: { type: 'email', channel: 'email', subject, body } });
      closeOverlays(); toast('Logged as contacted'); fire();
    };
  });
}

export async function bookingModal(pre = {}, done) {
  // The venue picker can't depend on some other view having loaded first — a booking
  // created from the Calendar would get an empty dropdown.
  if (!pre.venue_name && !state.venues.length) {
    try { state.venues = (await api('/api/venues?limit=1000&sort=name')).venues; } catch { /* picker just stays empty */ }
  }
  const venues = state.venues;
  openModal(`
    <header><h2>${pre.id ? 'Edit booking' : 'New booking'}</h2><button class="x" data-close>×</button></header>
    <div class="body">
      ${pre.venue_name ? `<div class="muted" style="margin-bottom:10px">${esc(pre.venue_name)}</div>`
      : field('Venue', selectHtml('venue_id', [{ value: '', label: '— none —' }, ...venues.map(v => ({ value: v.id, label: v.name }))], pre.venue_id || ''))}
      <div class="grid2">
        ${field('Date', `<input type="date" id="date" value="${esc(pre.date || new Date().toISOString().slice(0, 10))}">`)}
        ${field('Status', selectHtml('status', ['hold', 'confirmed', 'played', 'cancelled'], pre.status || 'hold'))}
      </div>
      <div class="grid2">
        ${field('Set start', `<input type="time" id="start_time" value="${esc(pre.start_time || '23:00')}">`)}
        ${field('Set length (min)', `<input type="number" id="set_length" value="${pre.set_length || 120}">`)}
      </div>
      <div class="grid2">
        ${field('Fee ($)', `<input type="number" id="fee" value="${pre.fee ?? state.artist?.base_fee ?? 750}">`)}
        ${field('Deposit ($)', `<input type="number" id="deposit" value="${pre.deposit ?? ''}">`)}
      </div>
      <div class="grid2">
        ${field('Paid so far ($)', `<input type="number" id="paid" value="${pre.paid ?? 0}">`)}
        ${field('Travel cost ($)', `<input type="number" id="travel_cost" value="${pre.travel_cost ?? 0}">`)}
      </div>
      <label class="row" style="gap:8px;margin-bottom:12px"><input type="checkbox" id="deposit_paid" ${pre.deposit_paid ? 'checked' : ''} style="width:auto"> <span>Deposit received</span></label>
      ${field('Notes', `<textarea id="notes" placeholder="Load-in, sound guy, guest list, payment terms">${esc(pre.notes || '')}</textarea>`)}
    </div>
    <div class="foot">
      ${pre.id ? '<button class="btn" id="del">Delete</button>' : ''}
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="ok">${pre.id ? 'Save' : 'Create'}</button>
    </div>
  `, (m) => {
    m.querySelector('#ok').onclick = async () => {
      const body = {
        venue_id: pre.venue_id || (m.querySelector('#venue_id')?.value ? parseInt(m.querySelector('#venue_id').value, 10) : null),
        date: m.querySelector('#date').value,
        status: m.querySelector('#status').value,
        start_time: m.querySelector('#start_time').value,
        set_length: parseInt(m.querySelector('#set_length').value, 10) || null,
        fee: parseFloat(m.querySelector('#fee').value) || 0,
        deposit: parseFloat(m.querySelector('#deposit').value) || 0,
        paid: parseFloat(m.querySelector('#paid').value) || 0,
        travel_cost: parseFloat(m.querySelector('#travel_cost').value) || 0,
        deposit_paid: m.querySelector('#deposit_paid').checked,
        notes: m.querySelector('#notes').value || null,
      };
      if (pre.venue_name) body.title = `${state.artist?.name || 'Set'} @ ${pre.venue_name}`;
      try {
        if (pre.id) await api('/api/bookings/' + pre.id, { method: 'PATCH', body });
        else await api('/api/bookings', { method: 'POST', body });
        closeOverlays(); toast(pre.id ? 'Booking updated' : 'Booking created');
        if (done) done();
      } catch (e) { toast(e.message, 'err'); }
    };
    const del = m.querySelector('#del');
    if (del) del.onclick = async () => {
      await api('/api/bookings/' + pre.id, { method: 'DELETE' });
      closeOverlays(); toast('Deleted'); if (done) done();
    };
  });
}
