// app.js — boot, hash router, navigation, live event stream.
import { api, state, toast, closeOverlays } from './core.js';
import * as dashboard from './views/dashboard.js';
import * as leads from './views/leads.js';
import * as pipeline from './views/pipeline.js';
import * as calendar from './views/calendar.js';
import * as finance from './views/finance.js';
import * as analytics from './views/analytics.js';
import * as workflow from './views/workflow.js';
import * as artist from './views/artist.js';
import * as settings from './views/settings.js';

const VIEWS = {
  dashboard: { mod: dashboard, title: 'Tonight', icon: '◎', label: 'Home', mobile: true },
  leads: { mod: leads, title: 'Venues', icon: '☰', label: 'Venues', mobile: true },
  pipeline: { mod: pipeline, title: 'Pipeline', icon: '⛁', label: 'Pipeline', mobile: true },
  calendar: { mod: calendar, title: 'Calendar', icon: '▦', label: 'Calendar', mobile: true },
  analytics: { mod: analytics, title: 'Analytics', icon: '◈', label: 'Map', mobile: true },
  finance: { mod: finance, title: 'Financials', icon: '$', label: 'Money' },
  workflow: { mod: workflow, title: 'Workflow', icon: '⚡', label: 'Flow' },
  artist: { mod: artist, title: 'Artist / EPK', icon: '★', label: 'EPK' },
  settings: { mod: settings, title: 'Settings', icon: '⚙', label: 'Settings' },
};
const ORDER = ['dashboard', 'leads', 'pipeline', 'calendar', 'analytics', 'finance', 'workflow'];

export function go(route, params) {
  const hash = '#/' + route + (params ? '?' + new URLSearchParams(params) : '');
  if (location.hash === hash) render();
  else location.hash = hash;
}

function currentRoute() {
  const raw = (location.hash || '#/dashboard').slice(2);
  const [route, qs] = raw.split('?');
  return { route: VIEWS[route] ? route : 'dashboard', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

let activeMod = null;
async function render() {
  const { route, params } = currentRoute();
  const def = VIEWS[route];
  document.getElementById('title').textContent = def.title;
  document.getElementById('subtitle').textContent = '';
  document.getElementById('topActions').innerHTML = '';
  document.querySelectorAll('.navlink').forEach(n => n.classList.toggle('on', n.dataset.route === route));
  document.querySelectorAll('.mobnav button').forEach(n => n.classList.toggle('on', n.dataset.route === route));
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty"><span class="spin"></span></div>';
  if (activeMod?.unmount) { try { activeMod.unmount(); } catch {} }
  activeMod = def.mod;
  try { await def.mod.mount(view, params); }
  catch (e) { view.innerHTML = `<div class="empty">Couldn't load this view — ${e.message}</div>`; }
}

function buildNav() {
  document.getElementById('navlinks').innerHTML = ORDER.map(k =>
    `<div class="navlink" data-route="${k}"><span class="ic">${VIEWS[k].icon}</span> ${VIEWS[k].title}<span class="badge hide" data-badge="${k}"></span></div>`).join('');
  document.getElementById('mobnav').innerHTML = ORDER.filter(k => VIEWS[k].mobile).map(k =>
    `<button data-route="${k}"><span class="ic">${VIEWS[k].icon}</span>${VIEWS[k].label}<span class="badge hide" data-mbadge="${k}"></span></button>`).join('');
  document.querySelectorAll('[data-route]').forEach(el => el.addEventListener('click', () => { closeOverlays(); go(el.dataset.route); }));
}

export function setBadges() {
  const n = state.counts.openTasks || 0;
  document.querySelectorAll('[data-badge="dashboard"],[data-mbadge="dashboard"]').forEach(b => {
    b.textContent = n; b.classList.toggle('hide', !n);
  });
}

export async function refreshCounts() {
  const boot = await api('/api/bootstrap');
  Object.assign(state, boot);
  setBadges();
}

// ─── live stream ───────────────────────────────────────────────────────────────
function connectStream() {
  const dot = document.getElementById('liveDot'), text = document.getElementById('liveText');
  const es = new EventSource('/api/events');
  es.onopen = () => { dot.classList.remove('off'); text.textContent = 'live'; };
  es.onerror = () => { dot.classList.add('off'); text.textContent = 'reconnecting…'; };
  es.addEventListener('automation', (e) => {
    const d = JSON.parse(e.data);
    toast(`${d.created} task${d.created === 1 ? '' : 's'} created by workflow rules`);
    refreshCounts().then(() => { if (currentRoute().route === 'dashboard') render(); });
  });
  es.addEventListener('changed', () => { refreshCounts().catch(() => {}); });
}

// ─── boot ──────────────────────────────────────────────────────────────────────
(async function boot() {
  buildNav();
  window.addEventListener('hashchange', render);
  document.getElementById('logout').addEventListener('click', async (e) => {
    e.preventDefault(); await fetch('/api/logout'); location.href = '/login.html';
  });
  try {
    const boot = await api('/api/bootstrap');
    Object.assign(state, boot);
  } catch (e) { document.getElementById('view').innerHTML = `<div class="empty">${e.message}</div>`; return; }
  document.getElementById('artistName').textContent = state.artist?.name || 'Artist';
  document.getElementById('artistMark').textContent =
    (state.artist?.name || 'Booking OS').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  setBadges();
  connectStream();
  await render();
})();
