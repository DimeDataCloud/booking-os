// dashboard.js — "Tonight": what needs doing, what's coming, what changed.
import { api, state, esc, money, dateLabel, ago, stat, card, stagePill, scoreTag, toast } from '../core.js';
import { openVenue, onVenueChange, bookingModal, composeFor } from '../venue.js';
import { go, refreshCounts } from '../app.js';

export async function mount(view) {
  const [tasksRes, bookRes, finance, analytics, leadsRes, feed] = await Promise.all([
    api('/api/tasks?status=open'),
    api('/api/bookings?from=' + new Date().toISOString().slice(0, 10)),
    api('/api/finance'),
    api('/api/analytics'),
    api('/api/venues?has=contact&stage=prospect&sort=score&limit=8'),
    api('/api/feed'),
  ]);
  state.tasks = tasksRes.tasks;
  const upcoming = bookRes.bookings.filter(b => b.status !== 'cancelled').slice(0, 6);
  const next = upcoming[0];
  const overdue = state.tasks.filter(t => t.due_at && t.due_at < new Date().toISOString());

  document.getElementById('subtitle').textContent =
    `${state.counts.venues} venues · ${state.counts.withEmail} with email · ${state.counts.openTasks} open tasks`;
  document.getElementById('topActions').innerHTML =
    `<button class="btn" id="runAuto">Run workflow</button><button class="btn primary" id="newBooking">+ Booking</button>`;
  document.getElementById('runAuto').onclick = async (e) => {
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> running';
    const r = await api('/api/automations/run', { method: 'POST' });
    toast(r.created ? `${r.created} task(s) created` : 'Nothing due — all clear');
    await refreshCounts(); mount(view);
  };
  document.getElementById('newBooking').onclick = () => bookingModal({}, () => mount(view));

  view.innerHTML = `
    <div class="stats">
      ${stat('Next show', next ? esc(dateLabel(next.date)) : '—', next ? esc(next.venue_name || next.title) : 'nothing booked')}
      ${stat('Confirmed pipeline', money(finance.totals.gross), `${finance.totals.gigs} gigs this year`)}
      ${stat('Outstanding', money(finance.totals.outstanding), 'unpaid fees', finance.totals.outstanding > 0 ? 'warn' : 'good')}
      ${stat('Open tasks', String(state.tasks.length), overdue.length ? `${overdue.length} overdue` : 'on top of it', overdue.length ? 'bad' : '')}
    </div>

    <div class="cols side">
      <div>
        ${card('Do this next', state.tasks.length ? `
          <div id="taskList">${state.tasks.slice(0, 12).map(t => `
            <div class="row" style="gap:10px;padding:9px 0;border-bottom:1px solid var(--line);align-items:flex-start">
              <button class="btn sm" data-done="${t.id}" title="Complete">✓</button>
              <div style="flex:1;min-width:0">
                <div style="font-size:13.5px;${t.priority === 'high' ? 'font-weight:600' : ''}">${esc(t.title)}</div>
                <div class="dim" style="font-size:11.5px">
                  ${t.venue_name ? esc(t.venue_name) + ' · ' : ''}${t.due_at ? esc(ago(t.due_at)) : ''}${t.auto ? ' · auto' : ''}
                </div>
              </div>
              ${t.venue_id ? `<button class="btn sm" data-open="${t.venue_id}">Open</button>` : ''}
            </div>`).join('')}</div>` : '<div class="empty">Nothing queued. Run the workflow or work the hot list.</div>')}

        <div style="height:14px"></div>
        ${card('Hot leads — contactable, never pitched', leadsRes.venues.length ? `
          <div class="tbl-wrap" style="max-height:none">
          <table><tbody>
            ${leadsRes.venues.map(v => `<tr data-open="${v.id}">
              <td><b>${esc(v.name)}</b><div class="dim" style="font-size:11.5px">${esc(v.city || '')}${v.capacity ? ' · ~' + v.capacity + ' cap' : ''}</div></td>
              <td class="dim" style="font-size:12px">${v.email ? '✉' : ''} ${v.phone ? '☎' : ''}</td>
              <td style="text-align:right">${scoreTag(v.score)}</td>
              <td style="text-align:right"><button class="btn sm" data-pitch="${v.id}">Pitch</button></td>
            </tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No contactable prospects — run the lead generator.</div>')}
      </div>

      <div>
        ${card('Upcoming', upcoming.length ? upcoming.map(b => `
          <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
            <div>
              <div style="font-size:13px;font-weight:600">${esc(b.venue_name || b.title)}</div>
              <div class="dim" style="font-size:11.5px">${esc(dateLabel(b.date))}${b.start_time ? ' · ' + esc(b.start_time) : ''} · ${esc(b.status)}</div>
            </div>
            <div class="mono" style="font-size:13px">${money(b.fee)}</div>
          </div>`).join('') : '<div class="empty">No shows on the books.</div>')}

        <div style="height:14px"></div>
        ${card('Funnel', analytics.funnel.map(f => {
          const max = analytics.funnel[0].count || 1;
          return `<div class="funnel-row"><div class="lbl">${esc(f.label)}</div>
            <div class="track"><div class="fill" style="width:${Math.max(2, (f.count / max) * 100)}%"></div></div>
            <div class="num">${f.count}</div></div>`;
        }).join('') + `<div class="dim" style="font-size:11.5px;margin-top:6px">
          reply rate ${(analytics.rates.replyRate * 100).toFixed(0)}% · book rate ${(analytics.rates.bookRate * 100).toFixed(0)}%</div>`)}

        <div style="height:14px"></div>
        ${card('Activity', feed.events.length ? `<div class="tl">${feed.events.slice(0, 12).map(e => `
          <div class="tl-item"><div class="h">${esc(e.message)}</div><div class="t">${esc(ago(e.created_at))}</div></div>`).join('')}</div>`
          : '<div class="dim" style="font-size:12.5px">Quiet so far.</div>')}
      </div>
    </div>`;

  view.querySelectorAll('[data-done]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/tasks/' + b.dataset.done, { method: 'PATCH', body: { status: 'done' } });
    await refreshCounts(); mount(view);
  });
  view.querySelectorAll('[data-open]').forEach(el => el.onclick = (e) => { e.stopPropagation(); openVenue(el.dataset.open); });
  view.querySelectorAll('[data-pitch]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const v = leadsRes.venues.find(x => String(x.id) === b.dataset.pitch);
    if (v) composeFor(v);
  });
  onVenueChange(() => mount(view));
}
