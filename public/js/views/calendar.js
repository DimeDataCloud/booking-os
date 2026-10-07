// calendar.js — month grid + agenda. Tap a day to book it.
import { api, state, esc, money, dateLabel, toast } from '../core.js';
import { bookingModal, openVenue } from '../venue.js';

let cursor = new Date();

export async function mount(view) {
  document.getElementById('topActions').innerHTML = `
    <button class="btn sm" id="prev">‹</button>
    <button class="btn sm" id="today">Today</button>
    <button class="btn sm" id="next">›</button>
    <button class="btn primary" id="add">+ Booking</button>`;

  const render = async () => {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
    const from = new Date(y, m, 1 - first.getDay()).toISOString().slice(0, 10);
    const to = new Date(y, m + 1, 6 - last.getDay()).toISOString().slice(0, 10);
    const { bookings } = await api(`/api/bookings?from=${from}&to=${to}`);
    const all = await api('/api/bookings');
    state.bookings = all.bookings;
    const byDate = {};
    bookings.forEach(b => { (byDate[b.date] ||= []).push(b); });

    document.getElementById('title').textContent = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const monthGigs = bookings.filter(b => b.date.slice(0, 7) === `${y}-${String(m + 1).padStart(2, '0')}` && b.status !== 'cancelled');
    document.getElementById('subtitle').textContent =
      `${monthGigs.length} shows · ${money(monthGigs.reduce((s, b) => s + (b.fee || 0), 0))} booked`;

    const cells = [];
    const start = new Date(from + 'T12:00:00');
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const evs = byDate[iso] || [];
      const isToday = iso === new Date().toISOString().slice(0, 10);
      cells.push(`<div class="day ${d.getMonth() !== m ? 'other' : ''} ${isToday ? 'today' : ''}" data-date="${iso}">
        <div class="n">${d.getDate()}</div>
        ${evs.map(e => `<div class="ev ${esc(e.status)}" data-id="${e.id}">${esc(e.venue_name || e.title)}</div>`).join('')}
      </div>`);
      if (i >= 34 && d.getMonth() !== m) break;
    }

    const upcoming = state.bookings.filter(b => b.date >= new Date().toISOString().slice(0, 10) && b.status !== 'cancelled').slice(0, 12);
    view.innerHTML = `
      <div class="cal">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="dow">${d}</div>`).join('')}
        ${cells.join('')}
      </div>
      <div style="height:16px"></div>
      <div class="card"><h3>Agenda</h3>
        ${upcoming.length ? upcoming.map(b => `
          <div class="row" style="justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer" data-id="${b.id}">
            <div>
              <div style="font-weight:600;font-size:13.5px">${esc(b.venue_name || b.title)}</div>
              <div class="dim" style="font-size:11.5px">${esc(dateLabel(b.date))}${b.start_time ? ' · ' + esc(b.start_time) : ''}${b.set_length ? ` · ${b.set_length}min` : ''} · ${esc(b.status)}</div>
            </div>
            <div style="text-align:right">
              <div class="mono">${money(b.fee)}</div>
              ${b.deposit > 0 ? `<div class="dim" style="font-size:11px">${b.deposit_paid ? 'deposit in' : 'deposit due'}</div>` : ''}
            </div>
          </div>`).join('') : '<div class="empty">Nothing on the books yet.</div>'}
      </div>`;

    view.querySelectorAll('.day').forEach(d => d.onclick = (e) => {
      if (e.target.classList.contains('ev')) return;
      bookingModal({ date: d.dataset.date }, render);
    });
    view.querySelectorAll('[data-id]').forEach(el => el.onclick = (e) => {
      e.stopPropagation();
      const b = state.bookings.find(x => String(x.id) === el.dataset.id);
      if (b) bookingModal(b, render);
    });
  };

  document.getElementById('prev').onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); render(); };
  document.getElementById('next').onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); render(); };
  document.getElementById('today').onclick = () => { cursor = new Date(); render(); };
  document.getElementById('add').onclick = () => bookingModal({}, render);
  await render();
}
