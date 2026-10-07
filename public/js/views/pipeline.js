// pipeline.js — drag-and-drop kanban across the booking stages.
import { api, state, esc, money, toast, scoreTag } from '../core.js';
import { openVenue, onVenueChange } from '../venue.js';

const BOARD_STAGES = ['prospect', 'researching', 'contacted', 'in_conversation', 'negotiating', 'booked', 'played', 'repeat'];

export async function mount(view) {
  document.getElementById('topActions').innerHTML = '<button class="btn" id="showPassed">Show passed</button>';
  let showPassed = false;
  const render = async () => {
    const { venues } = await api('/api/venues?limit=1200&sort=score');
    state.venues = venues;
    const stages = showPassed ? [...BOARD_STAGES, 'passed'] : BOARD_STAGES;
    const byStage = Object.fromEntries(stages.map(s => [s, []]));
    venues.forEach(v => { if (byStage[v.stage]) byStage[v.stage].push(v); });
    const active = venues.filter(v => !['prospect', 'passed'].includes(v.stage)).length;
    document.getElementById('subtitle').textContent = `${active} venues in play · ${venues.length} total`;

    view.innerHTML = `<div class="board">${stages.map(s => `
      <div class="board-col" data-stage="${s}">
        <h4>${esc(state.stages.find(x => x.key === s)?.label || s)} <em>${byStage[s].length}</em></h4>
        <div class="col-body" data-stage="${s}">
          ${byStage[s].slice(0, 60).map(v => `
            <div class="kcard" draggable="true" data-id="${v.id}">
              <b>${esc(v.name)}</b>
              <div class="meta">
                <span>${esc(v.city || '')}</span>
                ${v.capacity ? `<span>~${v.capacity}</span>` : ''}
                ${v.email ? '<span style="color:var(--cyan)">✉</span>' : ''}
                ${v.fee_target ? `<span class="mono">${money(v.fee_target)}</span>` : ''}
                ${scoreTag(v.score)}
              </div>
            </div>`).join('')}
          ${byStage[s].length > 60 ? `<div class="dim" style="font-size:11px;padding:6px">+${byStage[s].length - 60} more</div>` : ''}
        </div>
      </div>`).join('')}</div>`;

    let dragId = null;
    view.querySelectorAll('.kcard').forEach(c => {
      c.addEventListener('click', () => openVenue(c.dataset.id));
      c.addEventListener('dragstart', (e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      c.addEventListener('dragend', () => { c.classList.remove('dragging'); dragId = null; });
      // Touch: long-press opens a stage picker, since drag-and-drop on phones is a lie.
      let timer;
      c.addEventListener('touchstart', () => { timer = setTimeout(() => stagePicker(c.dataset.id, render), 550); }, { passive: true });
      c.addEventListener('touchend', () => clearTimeout(timer));
      c.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
    });
    view.querySelectorAll('.board-col').forEach(col => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault(); col.classList.remove('drag');
        if (!dragId) return;
        const stage = col.dataset.stage;
        await api('/api/venues/' + dragId, { method: 'PATCH', body: { stage } });
        toast('Moved to ' + (state.stages.find(x => x.key === stage)?.label || stage));
        render();
      });
    });
  };
  document.getElementById('showPassed').onclick = (e) => {
    showPassed = !showPassed;
    e.target.textContent = showPassed ? 'Hide passed' : 'Show passed';
    render();
  };
  onVenueChange(render);
  await render();
}

function stagePicker(id, done) {
  import('../core.js').then(({ openModal, closeOverlays, api: a }) => {
    openModal(`<header><h2>Move to…</h2><button class="x" data-close>×</button></header>
      <div class="body"><div class="chips" style="flex-wrap:wrap;gap:8px">
        ${state.stages.map(s => `<button class="chip" data-s="${s.key}">${esc(s.label)}</button>`).join('')}
      </div></div>`, (m) => {
      m.querySelectorAll('[data-s]').forEach(b => b.onclick = async () => {
        await a('/api/venues/' + id, { method: 'PATCH', body: { stage: b.dataset.s } });
        closeOverlays(); toast('Moved'); done();
      });
    });
  });
}
