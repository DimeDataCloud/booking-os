// artist.js — the artist profile doubles as the EPK you paste into a pitch.
import { api, state, esc, money, card, field, toast } from '../core.js';

export async function mount(view) {
  const a = await api('/api/artist') || {};
  state.artist = a;
  document.getElementById('subtitle').textContent = 'What venues see when you pitch';
  document.getElementById('topActions').innerHTML = '<button class="btn" id="copyEpk">Copy EPK text</button>';

  view.innerHTML = `
    <div class="cols side">
      <div>
        <div class="card" style="padding:0;overflow:hidden;margin-bottom:14px">
          <div style="background:linear-gradient(120deg,rgba(124,92,255,.35),rgba(33,230,193,.22));padding:28px 22px">
            <div style="font-size:30px;font-weight:700;letter-spacing:-.03em">${esc(a.name || 'Artist')}</div>
            <div class="muted" style="margin-top:4px">${esc(a.tagline || '')}</div>
            <div class="row" style="margin-top:16px">
              ${a.spotify ? `<a class="btn sm" href="${esc(a.spotify)}" target="_blank" rel="noopener">Spotify</a>` : ''}
              ${a.tiktok ? `<a class="btn sm" href="${esc(a.tiktok)}" target="_blank" rel="noopener">TikTok</a>` : ''}
            </div>
          </div>
          ${a.spotify_id ? `<iframe style="border-radius:0;border:0;display:block"
             src="https://open.spotify.com/embed/artist/${esc(a.spotify_id)}?utm_source=generator&theme=0"
             width="100%" height="352" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
             loading="lazy"></iframe>` : ''}
        </div>

        ${card('Edit the profile', `
          <div class="grid2">
            ${field('Artist name', `<input type="text" id="name" value="${esc(a.name || '')}">`)}
            ${field('Tagline', `<input type="text" id="tagline" value="${esc(a.tagline || '')}">`)}
          </div>
          <div class="grid2">
            ${field('Spotify artist URL', `<input type="text" id="spotify" value="${esc(a.spotify || '')}">`)}
            ${field('TikTok URL', `<input type="text" id="tiktok" value="${esc(a.tiktok || '')}">`)}
          </div>
          <div class="grid2">
            ${field('Home base', `<input type="text" id="home_base" value="${esc(a.home_base || '')}">`)}
            ${field('Standard fee ($)', `<input type="number" id="base_fee" value="${a.base_fee ?? 750}">`)}
          </div>
          ${field('Email signature', `<textarea id="signature" style="min-height:70px">${esc(a.signature || '')}</textarea>`)}
          ${field('Bio / pitch paragraph', `<textarea id="bio" style="min-height:120px" placeholder="Two sentences a talent buyer will actually read.">${esc(a.bio || '')}</textarea>`)}
          <button class="btn primary" id="save">Save</button>`)}
      </div>

      <div>
        ${card('Pitch kit', `
          <div class="dim" style="font-size:12.5px;margin-bottom:10px">Everything a talent buyer asks for, in the order they ask.</div>
          <div style="font-size:13px;line-height:1.9">
            <div>Standard fee — <b class="mono">${money(a.base_fee || 0)}</b></div>
            <div>Based in — <b>${esc(a.home_base || '—')}</b></div>
            <div>Manager — <b>${esc(a.manager || 'Manager')}</b></div>
            <div>Booking email — <b>${esc(a.manager_email || '—')}</b></div>
          </div>`)}
        <div style="height:14px"></div>
        ${card('EPK text', `<textarea id="epk" style="min-height:260px;font-size:12.5px" readonly>${esc(epkText(a))}</textarea>`)}
      </div>
    </div>`;

  view.querySelector('#save').onclick = async () => {
    const body = {};
    ['name', 'tagline', 'spotify', 'tiktok', 'home_base', 'signature', 'bio'].forEach(k => { body[k] = view.querySelector('#' + k).value; });
    body.base_fee = parseFloat(view.querySelector('#base_fee').value) || 0;
    const m = (body.spotify || '').match(/artist\/([A-Za-z0-9]+)/);
    if (m) body.spotify_id = m[1];
    await api('/api/artist', { method: 'PATCH', body });
    toast('Saved');
    document.getElementById('artistName').textContent = body.name;
    mount(view);
  };
  document.getElementById('copyEpk').onclick = () => {
    navigator.clipboard.writeText(epkText(state.artist)).then(() => toast('EPK copied'));
  };
}

function epkText(a) {
  return `${a.name || 'Artist'} — ${a.tagline || ''}
Based in ${a.home_base || ''}

${a.bio || ''}

Listen: ${a.spotify || ''}
Video: ${a.tiktok || ''}

Standard fee: ${a.base_fee ? '$' + a.base_fee : 'on request'}
Set length: 90–180 minutes, open-to-close available
Booking: ${a.manager || 'Manager'} · ${a.manager_email || ''}`;
}
