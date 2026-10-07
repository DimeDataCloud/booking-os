// workflow.js — automation rules, message templates, and the task queue in one place.
import { api, state, esc, ago, card, toast, openModal, closeOverlays, field, selectHtml } from '../core.js';
import { openVenue } from '../venue.js';
import { refreshCounts } from '../app.js';

const TRIGGER_LABEL = {
  no_reply_days: 'venue went quiet after contact',
  stage_age_days: 'stuck in a stage too long',
  booking_upcoming_days: 'show is coming up',
  deposit_unpaid_days: 'deposit not received',
  played_days_ago: 'show finished a while ago',
  payout_overdue_days: 'fee still unpaid after the show',
};

export async function mount(view) {
  document.getElementById('topActions').innerHTML =
    '<button class="btn" id="newTpl">+ Template</button><button class="btn primary" id="run">Run now</button>';

  const render = async () => {
    const [{ automations }, { templates }, { tasks }] = await Promise.all([
      api('/api/automations'), api('/api/templates'), api('/api/tasks?status=open'),
    ]);
    const enabled = automations.filter(a => a.enabled).length;
    document.getElementById('subtitle').textContent = `${enabled}/${automations.length} rules on · ${tasks.length} open tasks`;

    view.innerHTML = `
      <div class="cols side">
        <div>
          ${card('Automation rules', automations.map(a => `
            <div class="row" style="justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line);gap:12px">
              <div style="flex:1;min-width:0">
                <div style="font-size:13.5px;font-weight:600">${esc(a.name)}</div>
                <div class="dim" style="font-size:11.5px">
                  When ${esc(TRIGGER_LABEL[a.trigger] || a.trigger)}${a.params.days ? ` (${a.params.days} days)` : ''} → create a task${a.action_params.template ? ` + draft "${esc(a.action_params.template)}"` : ''}
                </div>
                <div class="dim" style="font-size:11px;margin-top:2px">
                  ${a.run_count ? `${a.run_count} task(s) created` : 'never fired'}${a.last_run_at ? ` · checked ${esc(ago(a.last_run_at))}` : ''}
                </div>
              </div>
              <div class="row" style="gap:6px">
                <button class="btn sm" data-days="${a.id}">${a.params.days ?? '—'}d</button>
                <button class="btn sm ${a.enabled ? 'primary' : ''}" data-toggle="${a.id}" data-on="${a.enabled}">${a.enabled ? 'On' : 'Off'}</button>
              </div>
            </div>`).join('') + `<div class="dim" style="font-size:11.5px;margin-top:10px">
              Rules run on the server every 15 minutes, whether or not this app is open.</div>`)}

          <div style="height:14px"></div>
          ${card('Message templates', templates.map(t => `
            <div class="row" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)">
              <div style="flex:1;min-width:0">
                <div style="font-size:13.5px;font-weight:600">${esc(t.name)}</div>
                <div class="dim" style="font-size:11.5px">${esc(t.channel)}${t.subject ? ' · ' + esc(t.subject) : ''}</div>
              </div>
              <button class="btn sm" data-edit="${t.id}">Edit</button>
            </div>`).join(''))}
        </div>

        <div>
          ${card('Task queue', tasks.length ? tasks.map(t => `
            <div class="row" style="gap:9px;padding:8px 0;border-bottom:1px solid var(--line);align-items:flex-start">
              <button class="btn sm" data-done="${t.id}">✓</button>
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px">${esc(t.title)}</div>
                <div class="dim" style="font-size:11px">${t.venue_name ? esc(t.venue_name) + ' · ' : ''}${t.auto ? 'auto' : 'manual'}${t.due_at ? ' · ' + esc(ago(t.due_at)) : ''}</div>
              </div>
              ${t.venue_id ? `<button class="btn sm" data-open="${t.venue_id}">→</button>` : ''}
            </div>`).join('') : '<div class="empty">Queue is empty.</div>')}
        </div>
      </div>`;

    view.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
      await api('/api/automations/' + b.dataset.toggle, { method: 'PATCH', body: { enabled: b.dataset.on !== '1' } });
      render();
    });
    view.querySelectorAll('[data-days]').forEach(b => b.onclick = () => {
      const a = automations.find(x => String(x.id) === b.dataset.days);
      openModal(`<header><h2>${esc(a.name)}</h2><button class="x" data-close>×</button></header>
        <div class="body">${field('Wait this many days', `<input type="number" id="d" value="${a.params.days ?? 5}" min="1" max="120">`)}</div>
        <div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Save</button></div>`, (m) => {
        m.querySelector('#ok').onclick = async () => {
          await api('/api/automations/' + a.id, { method: 'PATCH', body: { params: { ...a.params, days: parseInt(m.querySelector('#d').value, 10) } } });
          closeOverlays(); toast('Rule updated'); render();
        };
      });
    });
    view.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
      await api('/api/tasks/' + b.dataset.done, { method: 'PATCH', body: { status: 'done' } });
      await refreshCounts(); render();
    });
    view.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openVenue(b.dataset.open));
    view.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => templateModal(templates.find(t => String(t.id) === b.dataset.edit), render));
  };

  document.getElementById('run').onclick = async (e) => {
    e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span> running';
    const r = await api('/api/automations/run', { method: 'POST' });
    toast(r.created ? `${r.created} task(s) created` : 'Nothing due right now');
    await refreshCounts();
    mount(view);
  };
  document.getElementById('newTpl').onclick = () => templateModal(null, render);
  await render();
}

function templateModal(t, done) {
  openModal(`
    <header><h2>${t ? 'Edit template' : 'New template'}</h2><button class="x" data-close>×</button></header>
    <div class="body">
      ${field('Name', `<input type="text" id="name" value="${esc(t?.name || '')}">`)}
      ${field('Channel', selectHtml('channel', ['email', 'instagram', 'text'], t?.channel || 'email'))}
      ${field('Subject', `<input type="text" id="subject" value="${esc(t?.subject || '')}">`)}
      ${field('Body', `<textarea id="body" style="min-height:220px">${esc(t?.body || '')}</textarea>`)}
      <div class="dim" style="font-size:11.5px">Merge fields: {{venue}} {{city}} {{contact_first}} {{artist}} {{home_base}} {{month}} {{date}} {{fee}} {{deposit}} {{set_length}} {{spotify}} {{tiktok}} {{signature}}</div>
    </div>
    <div class="foot">
      ${t ? '<button class="btn" id="del">Delete</button>' : ''}
      <button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Save</button>
    </div>`, (m) => {
    m.querySelector('#ok').onclick = async () => {
      const body = {
        name: m.querySelector('#name').value, channel: m.querySelector('#channel').value,
        subject: m.querySelector('#subject').value || null, body: m.querySelector('#body').value,
      };
      if (!body.name || !body.body) return toast('Name and body required', 'err');
      if (t) await api('/api/templates/' + t.id, { method: 'PATCH', body });
      else await api('/api/templates', { method: 'POST', body });
      closeOverlays(); toast('Saved'); done();
    };
    const d = m.querySelector('#del');
    if (d) d.onclick = async () => { await api('/api/templates/' + t.id, { method: 'DELETE' }); closeOverlays(); toast('Deleted'); done(); };
  });
}
