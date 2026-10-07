// settings.js — account, data, and the honest list of what this thing does and doesn't do.
import { api, state, esc, card, field, toast } from '../core.js';

export async function mount(view) {
  document.getElementById('subtitle').textContent = state.user?.email || '';
  document.getElementById('topActions').innerHTML = '';

  view.innerHTML = `
    <div class="cols c2">
      <div>
        ${card('Account', `
          <div class="muted" style="font-size:13px;margin-bottom:14px">Signed in as <b>${esc(state.user?.name || '')}</b> · ${esc(state.user?.email || '')}</div>
          ${field('Current password', '<input type="password" id="cur" autocomplete="current-password">')}
          ${field('New password', '<input type="password" id="next" autocomplete="new-password">')}
          <button class="btn primary" id="pw">Change password</button>`)}

        <div style="height:14px"></div>
        ${card('Your data', `
          <div class="row">
            <a class="btn" href="/api/export/venues.csv">Export all venues (CSV)</a>
            <a class="btn" href="/api/export/venues.csv?has=contact">Export contactable only</a>
          </div>
          <div class="dim" style="font-size:11.5px;margin-top:10px">
            ${state.counts.venues} venues · ${state.counts.withEmail} with email · ${state.counts.withPhone} with phone.
          </div>`)}
      </div>

      <div>
        ${card('How this works', `
          <div style="font-size:13px;line-height:1.75;color:var(--txt-2)">
            <p><b style="color:var(--txt)">Venues</b> come from OpenStreetMap — nightclubs, dance halls, event spaces and
            music bars across the areas in config/areas.json. Contact details are read from each venue's own public website.
            Nothing is invented: if a site can't be read, the field stays empty and says so.</p>
            <p style="margin-top:10px"><b style="color:var(--txt)">Sending happens in your mail app.</b> This drafts the
            message and logs the touch — it does not send on your behalf, so nothing goes out that you didn't see.</p>
            <p style="margin-top:10px"><b style="color:var(--txt)">Automations run server-side</b> every 15 minutes, whether
            or not this app is open. They create tasks; they never message anyone.</p>
            <p style="margin-top:10px"><b style="color:var(--txt)">One rule worth knowing:</b> logging an email, call, DM or
            text automatically moves a prospect to Contacted and starts the follow-up clock.</p>
          </div>`)}
      </div>
    </div>`;

  view.querySelector('#pw').onclick = async () => {
    const current = view.querySelector('#cur').value, next = view.querySelector('#next').value;
    try {
      await api('/api/password', { method: 'POST', body: { current, next } });
      toast('Password changed');
      view.querySelector('#cur').value = ''; view.querySelector('#next').value = '';
    } catch (e) { toast(e.message, 'err'); }
  };
}
