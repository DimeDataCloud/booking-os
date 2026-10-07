// core.js — api client, shared state, formatting, and the UI primitives every view uses.

export const state = {
  user: null, artist: null, stages: [], areas: [], counts: {},
  venues: [], venueTotal: 0, tasks: [], bookings: [], analytics: null, finance: null,
  filters: { stage: 'all', area: 'all', has: 'all', q: '', sort: 'score' },
};

// ─── api ───────────────────────────────────────────────────────────────────────
const bar = () => document.getElementById('loadbar');
let inflight = 0;
function loading(on) {
  inflight += on ? 1 : -1;
  const b = bar();
  if (!b) return;
  if (inflight > 0) { b.style.width = '70%'; }
  else { b.style.width = '100%'; setTimeout(() => { b.style.width = '0'; }, 260); }
}

export async function api(path, opts = {}) {
  loading(true);
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { location.href = '/login.html'; throw new Error('signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  } finally { loading(false); }
}

// ─── formatting ────────────────────────────────────────────────────────────────
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n, dp = 0) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const pct = (n) => (n * 100).toFixed(n >= 0.1 ? 0 : 1) + '%';
export const todayISO = () => new Date().toISOString().slice(0, 10);
export function dateLabel(d) {
  if (!d) return '—';
  const dt = new Date(d + (d.length === 10 ? 'T12:00:00' : ''));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: dt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
export function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  const d = Math.floor(s / 86400);
  return d < 30 ? d + 'd ago' : dateLabel(iso.slice(0, 10));
}
export const stageLabel = (k) => (state.stages.find(s => s.key === k) || {}).label || k;
export const stagePill = (k) => `<span class="pill st-${esc(k)}">${esc(stageLabel(k))}</span>`;
export const bookPill = (s) => `<span class="pill bk-${esc(s)}">${esc(s)}</span>`;
export const scoreTag = (n) => `<span class="score ${n >= 70 ? 'hi' : n >= 45 ? 'mid' : ''}">${n ?? 0}</span>`;

// ─── toasts ────────────────────────────────────────────────────────────────────
export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, kind === 'err' ? 6000 : 3400);
}

// ─── drawer + modal ────────────────────────────────────────────────────────────
const scrim = () => document.getElementById('scrim');
const drawerEl = () => document.getElementById('drawer');
const modalEl = () => document.getElementById('modal');

export function openDrawer(html, onMount) {
  const d = drawerEl();
  d.innerHTML = html;
  d.classList.add('on');
  scrim().classList.add('on');
  d.querySelectorAll('[data-close]').forEach(b => b.onclick = closeOverlays);
  if (onMount) onMount(d);
}
export function openModal(html, onMount) {
  const m = modalEl();
  m.innerHTML = html;
  m.classList.add('on');
  scrim().classList.add('on');
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = closeOverlays);
  if (onMount) onMount(m);
}
export function closeOverlays() {
  drawerEl().classList.remove('on');
  modalEl().classList.remove('on');
  scrim().classList.remove('on');
}
document.addEventListener('click', e => { if (e.target.id === 'scrim') closeOverlays(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverlays(); });

// ─── small builders ────────────────────────────────────────────────────────────
export const stat = (k, v, d, cls = '') => `<div class="stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
export const card = (title, body, cls = '') => `<div class="card ${cls}">${title ? `<h3>${esc(title)}</h3>` : ''}${body}</div>`;
export const field = (label, inner) => `<label class="f"><span>${esc(label)}</span>${inner}</label>`;
export function selectHtml(id, options, value, extra = '') {
  return `<select id="${id}" ${extra}>${options.map(o => `<option value="${esc(o.value ?? o)}" ${(o.value ?? o) === value ? 'selected' : ''}>${esc(o.label ?? o)}</option>`).join('')}</select>`;
}
export const confirmish = (msg) => new Promise(res => {
  openModal(`<header><h2>${esc(msg)}</h2></header><div class="foot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="yes">Confirm</button></div>`,
    (m) => { m.querySelector('#yes').onclick = () => { closeOverlays(); res(true); }; });
});
