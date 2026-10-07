// finance.js — money in, money out, money owed.
import { api, state, esc, money, dateLabel, stat, card, openModal, closeOverlays, field, toast, selectHtml } from '../core.js';
import { bookingModal } from '../venue.js';

let year = new Date().getFullYear();

export async function mount(view) {
  document.getElementById('topActions').innerHTML = `
    <button class="btn sm" id="py">‹ ${year - 1}</button>
    <button class="btn sm" id="ny">${year + 1} ›</button>
    <button class="btn" id="addExp">+ Expense</button>`;

  const render = async () => {
    const f = await api('/api/finance?year=' + year);
    state.finance = f;
    const t = f.totals;
    const maxMonth = Math.max(1, ...f.months.map(m => m.gross));
    document.getElementById('title').textContent = `Financials ${year}`;
    document.getElementById('subtitle').textContent =
      `${t.playedGigs} shows played · avg fee ${money(t.avgFee)}`;

    view.innerHTML = `
      <div class="stats">
        ${stat('Booked (gross)', money(t.gross), `${t.gigs} gigs`)}
        ${stat('Collected', money(t.collected), 'money actually in', 'good')}
        ${stat('Outstanding', money(t.outstanding), 'invoiced, unpaid', t.outstanding ? 'warn' : '')}
        ${stat('Deposits owed', money(t.depositsOwed), 'holds not secured', t.depositsOwed ? 'bad' : '')}
        ${stat('Expenses', money(t.expenses), 'travel + costs')}
        ${stat('Net', money(t.net), 'collected − expenses', t.net >= 0 ? 'good' : 'bad')}
      </div>

      <div class="cols side">
        <div>
          ${card(`Revenue by month — ${year}`, `<div class="bars">${f.months.map(m => `
            <div class="b" title="${esc(m.month)}: ${money(m.gross)}">
              <i style="height:${Math.max(2, (m.gross / maxMonth) * 100)}%"></i>
              <span>${m.month.slice(5)}</span>
            </div>`).join('')}</div>
            <div class="dim" style="font-size:11.5px;margin-top:8px">Bars are booked gross. Pipeline (holds) isn't counted: ${money(t.pipeline)} sitting in unconfirmed holds.</div>`)}

          <div style="height:14px"></div>
          ${card('Every booking', f.bookings.length ? `<div class="tbl-wrap" style="max-height:none"><table>
            <thead><tr><th>Date</th><th>Venue</th><th>Status</th><th style="text-align:right">Fee</th><th style="text-align:right">Paid</th><th style="text-align:right">Owed</th></tr></thead>
            <tbody>${f.bookings.map(b => {
              const owed = Math.max(0, (b.fee || 0) - (b.paid || 0));
              return `<tr data-id="${b.id}">
                <td class="mono" style="font-size:12px">${esc(b.date)}</td>
                <td>${esc(b.venue_name || b.title)}</td>
                <td><span class="pill bk-${esc(b.status)}">${esc(b.status)}</span></td>
                <td class="mono" style="text-align:right">${money(b.fee)}</td>
                <td class="mono" style="text-align:right">${money(b.paid)}</td>
                <td class="mono" style="text-align:right;${owed > 0 && b.status !== 'hold' ? 'color:var(--pink)' : 'color:var(--txt-3)'}">${owed ? money(owed) : '—'}</td>
              </tr>`;
            }).join('')}</tbody></table></div>` : '<div class="empty">No bookings this year.</div>')}
        </div>

        <div>
          ${card('Top venues by revenue', f.topVenues.length ? f.topVenues.map(v => `
            <div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)">
              <div><div style="font-size:13px">${esc(v.venue)}</div><div class="dim" style="font-size:11px">${v.gigs} gig${v.gigs === 1 ? '' : 's'}</div></div>
              <div class="mono">${money(v.gross)}</div>
            </div>`).join('') : '<div class="dim" style="font-size:12.5px">Nothing played yet.</div>')}

          <div style="height:14px"></div>
          ${card('Unit economics', `
            <div class="row" style="justify-content:space-between;padding:6px 0"><span class="muted">Average fee</span><span class="mono">${money(t.avgFee)}</span></div>
            <div class="row" style="justify-content:space-between;padding:6px 0"><span class="muted">Collection rate</span><span class="mono">${t.gross ? Math.round((t.collected / t.gross) * 100) : 0}%</span></div>
            <div class="row" style="justify-content:space-between;padding:6px 0"><span class="muted">Cost per show</span><span class="mono">${money(t.playedGigs ? t.expenses / t.playedGigs : 0)}</span></div>
            <div class="row" style="justify-content:space-between;padding:6px 0"><span class="muted">Net per show</span><span class="mono">${money(t.playedGigs ? t.net / t.playedGigs : 0)}</span></div>
            <div class="row" style="justify-content:space-between;padding:6px 0"><span class="muted">Holds in pipeline</span><span class="mono">${money(t.pipeline)}</span></div>`)}
        </div>
      </div>`;

    view.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => {
      const b = f.bookings.find(x => String(x.id) === tr.dataset.id);
      if (b) bookingModal(b, render);
    });
  };

  document.getElementById('py').onclick = () => { year--; mount(view); };
  document.getElementById('ny').onclick = () => { year++; mount(view); };
  document.getElementById('addExp').onclick = () => expenseModal(render);
  await render();
}

function expenseModal(done) {
  const bookings = (state.finance?.bookings || []);
  openModal(`
    <header><h2>Add expense</h2><button class="x" data-close>×</button></header>
    <div class="body">
      <div class="grid2">
        ${field('Category', selectHtml('category', ['travel', 'gear', 'promo', 'lodging', 'food', 'fees', 'other'], 'travel'))}
        ${field('Amount ($)', '<input type="number" id="amount">')}
      </div>
      ${field('Date', `<input type="date" id="date" value="${new Date().toISOString().slice(0, 10)}">`)}
      ${field('Tie to a booking', selectHtml('booking_id', [{ value: '', label: '— general —' }, ...bookings.map(b => ({ value: b.id, label: `${b.date} · ${b.venue_name || b.title}` }))], ''))}
      ${field('Note', '<input type="text" id="note">')}
    </div>
    <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Save</button></div>
  `, (m) => {
    m.querySelector('#ok').onclick = async () => {
      const amount = parseFloat(m.querySelector('#amount').value);
      if (!amount) return toast('Amount required', 'err');
      await api('/api/expenses', { method: 'POST', body: {
        category: m.querySelector('#category').value, amount,
        date: m.querySelector('#date').value,
        booking_id: m.querySelector('#booking_id').value ? parseInt(m.querySelector('#booking_id').value, 10) : null,
        note: m.querySelector('#note').value || null,
      } });
      closeOverlays(); toast('Expense logged'); done();
    };
  });
}
