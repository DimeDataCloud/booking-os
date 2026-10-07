// analytics.js — the 3D venue map plus the numbers that explain it.
import { api, state, esc, money, stat, card, toast } from '../core.js';
import { openVenue } from '../venue.js';
import { createVenueScene, STAGE_COLOR } from '../scene3d.js';

let scene = null;
let metric = 'capacity';

export function unmount() { if (scene) { scene.dispose(); scene = null; } }

export async function mount(view) {
  const a = await api('/api/analytics');
  state.analytics = a;
  const withContact = a.byArea.reduce((s, x) => s + x.with_email, 0);
  document.getElementById('subtitle').textContent = `${a.map.length} mapped venues · ${withContact} with a direct email`;
  document.getElementById('topActions').innerHTML = '<button class="btn sm" id="reset">Reset view</button>';

  view.innerHTML = `
    <div id="stage3d">
      <div id="canvasHost" style="position:absolute;inset:0"></div>
      <div class="stage-tools">
        ${['capacity', 'score', 'revenue'].map(m => `<button class="chip ${m === metric ? 'on' : ''}" data-metric="${m}">${m}</button>`).join('')}
      </div>
      <div class="stage-legend">
        ${Object.entries(STAGE_COLOR).filter(([k]) => k !== 'passed').map(([k, c]) =>
          `<span><i style="background:#${c.toString(16).padStart(6, '0')}"></i>${esc(k.replace('_', ' '))}</span>`).join('')}
      </div>
    </div>
    <div class="dim" style="font-size:11.5px;margin:8px 2px 16px">
      Drag to orbit · scroll or pinch to zoom · tap a pillar to open the venue. Height = ${esc(metric)}.
    </div>

    <div class="stats">
      ${a.funnel.map((f, i) => stat(f.label, String(f.count), i === 0 ? 'in the database' : '', i === 3 && f.count ? 'good' : '')).join('')}
    </div>

    <div class="cols c2">
      ${card('Coverage by area', `<div class="tbl-wrap" style="max-height:none"><table>
        <thead><tr><th>Area</th><th style="text-align:right">Venues</th><th style="text-align:right">With email</th><th style="text-align:right">Won</th></tr></thead>
        <tbody>${a.byArea.map(r => `<tr>
          <td>${esc(r.label || '—')} <span class="dim">${esc(r.state || '')}</span></td>
          <td class="mono" style="text-align:right">${r.c}</td>
          <td class="mono" style="text-align:right;color:${r.with_email ? 'var(--cyan)' : 'var(--txt-3)'}">${r.with_email}</td>
          <td class="mono" style="text-align:right">${r.won || 0}</td>
        </tr>`).join('')}</tbody></table></div>`)}

      <div>
        ${card('Pipeline by stage', a.byStage.map(s => {
          const max = Math.max(...a.byStage.map(x => x.c));
          return `<div class="funnel-row"><div class="lbl">${esc(s.stage.replace('_', ' '))}</div>
            <div class="track"><div class="fill" style="width:${Math.max(2, (s.c / max) * 100)}%"></div></div>
            <div class="num">${s.c}</div></div>`;
        }).join(''))}
        <div style="height:14px"></div>
        ${card('Venue types', a.byType.slice(0, 8).map(t => `
          <div class="row" style="justify-content:space-between;padding:5px 0">
            <span class="muted" style="font-size:12.5px">${esc(t.type || 'unclassified')}</span>
            <span class="mono">${t.c}</span></div>`).join(''))}
      </div>
    </div>`;

  const container = view.querySelector('#canvasHost');
  const build = () => {
    if (scene) scene.dispose();
    try {
      scene = createVenueScene(container, a.map, { metric, onPick: (v) => openVenue(v.id) });
    } catch (e) {
      container.innerHTML = `<div class="empty">3D map unavailable in this browser — ${esc(e.message)}</div>`;
    }
  };
  if (a.map.length) build();
  else container.innerHTML = '<div class="empty">No mapped venues yet. Run the lead generator.</div>';

  view.querySelectorAll('[data-metric]').forEach(b => b.onclick = () => {
    metric = b.dataset.metric;
    mount(view);
  });
  document.getElementById('reset').onclick = () => scene?.resetView();
}
