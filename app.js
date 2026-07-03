/* Family Hub PWA — vanilla JS, no build step (GoDaddy-friendly). */
'use strict';

const CFG = window.HUB_CONFIG;
const API = `${CFG.SUPABASE_URL}/functions/v1/api/api`;
const AUTH = `${CFG.SUPABASE_URL}/auth/v1`;

const $ = (id) => document.getElementById(id);
const state = { me: null, members: [], restrictions: null, thread: null, tab: 'today' };

// ----------------------------------------------------------------
// Auth (Supabase password grant + refresh)
// ----------------------------------------------------------------

const session = {
  get access() { return localStorage.getItem('hub_at'); },
  get refresh() { return localStorage.getItem('hub_rt'); },
  save(s) { localStorage.setItem('hub_at', s.access_token); localStorage.setItem('hub_rt', s.refresh_token); },
  clear() { localStorage.removeItem('hub_at'); localStorage.removeItem('hub_rt'); },
};

// Kids sign in with just their name: anything without an "@" is mapped
// to the hidden internal address (must match nameToLogin in the backend).
const KID_LOGIN_DOMAIN = 'kids.pocuslab.com';
const toLoginEmail = (input) => input.includes('@')
  ? input
  : `${input.toLowerCase().replace(/[^a-z0-9]/g, '')}@${KID_LOGIN_DOMAIN}`;

async function signIn(nameOrEmail, password) {
  const res = await fetch(`${AUTH}/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: CFG.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: toLoginEmail(nameOrEmail), password }),
  });
  if (!res.ok) throw new Error('Incorrect name or password.');
  session.save(await res.json());
}

async function refreshSession() {
  if (!session.refresh) return false;
  const res = await fetch(`${AUTH}/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: CFG.ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh }),
  });
  if (!res.ok) { session.clear(); return false; }
  session.save(await res.json());
  return true;
}

async function apiFetch(path, options = {}, retried = false) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.access}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401 && !retried && (await refreshSession())) {
    return apiFetch(path, options, true);
  }
  if (res.status === 401) { showSignin(); throw new Error('signed out'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json();
}

// ----------------------------------------------------------------
// Boot & shell
// ----------------------------------------------------------------

function showSignin() {
  session.clear();
  $('signin').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('composer').classList.add('hidden');
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  if (!session.access) return showSignin();
  try {
    const { me, members, restrictions, workspace } = await apiFetch('/me');
    Object.assign(state, { me, members, restrictions });
    $('familyName').textContent = workspace.name;
    $('whoami').textContent = me.displayName;
    $('signin').classList.add('hidden');
    $('app').classList.remove('hidden');
    buildTabs();
    switchTab('today');
    updateNotifBar();
    pollSos();
    setInterval(pollSos, 20_000);
  } catch (err) {
    if (err.message !== 'signed out') showSignin();
  }
}

const isParent = () => state.me?.role === 'admin';

function buildTabs() {
  const tabs = [
    { id: 'today', label: 'Today', icon: '📅' },
    { id: 'messages', label: 'Messages', icon: '💬' },
    ...(isParent()
      ? [{ id: 'admin', label: 'Admin', icon: '⚙️' }]
      : [{ id: 'sos', label: 'SOS', icon: '🆘' }]),
  ];
  $('tabs').innerHTML = tabs.map((t) =>
    `<button data-tab="${t.id}"><span class="ic">${t.icon}</span>${t.label}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

function switchTab(tab) {
  state.tab = tab;
  for (const view of ['today', 'messages', 'sos', 'admin']) {
    $(`view-${view}`).classList.toggle('hidden', view !== tab);
  }
  $('composer').classList.toggle('hidden', tab !== 'messages');
  $('tabs').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'today') loadToday();
  if (tab === 'messages') loadMessages();
  if (tab === 'admin') loadAdmin();
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.style.opacity = '1';
  setTimeout(() => (el.style.opacity = '0'), 2600);
}

// ----------------------------------------------------------------
// Today (agenda)
// ----------------------------------------------------------------

async function loadToday() {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 7 * 86400_000);
  const { events } = await apiFetch(`/events?from=${from.toISOString()}&to=${to.toISOString()}`);
  const colorOf = Object.fromEntries(state.members.map((m) => [m.id, m.color]));

  const days = [...Array(7)].map((_, i) => new Date(from.getTime() + i * 86400_000));
  $('view-today').innerHTML = days.map((day, i) => {
    const key = localDateKey(day);
    const list = events.filter((e) => occursOn(e, day, key))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    if (!list.length && i > 2) return '';
    return `<div class="day-group"><h2 class="${i === 0 ? 'today' : ''}">${i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric' })}</h2>
      ${list.map((e) => `
        <div class="ev" style="--c:${e.color ?? '#6b4ee6'}">
          <time>${e.isAllDay ? 'all day' : new Date(e.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
          <div><div class="name">${esc(e.title)}</div>
          ${(e.memberIds ?? []).length ? `<div class="dots">${e.memberIds.map((id) =>
            `<i style="background:${colorOf[id] ?? '#666'}"></i>`).join('')}</div>` : ''}</div>
        </div>`).join('') || '<div class="note">Nothing scheduled.</div>'}</div>`;
  }).join('');
}

const localDateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function occursOn(e, day, key) {
  if (e.isAllDay) return e.startsAt.slice(0, 10) <= key && key < e.endsAt.slice(0, 10);
  const next = new Date(day.getTime() + 86400_000);
  return new Date(e.startsAt) < next && new Date(e.endsAt) > day;
}

// ----------------------------------------------------------------
// Messages (family thread)
// ----------------------------------------------------------------

async function loadMessages() {
  if (!state.thread) {
    const { threads } = await apiFetch('/threads');
    state.thread = threads.find((t) => t.kind === 'family') ?? threads[0];
  }
  if (!state.thread) return;
  const { messages } = await apiFetch(`/threads/${state.thread.id}/messages`);
  $('msgList').innerHTML = messages.map((m) => `
    <div class="msg ${m.senderId === state.me.id ? 'mine' : ''} ${m.isAnnouncement ? 'announce' : ''}">
      <div class="from">${m.isAnnouncement ? '📣 ' : ''}${esc(m.senderName ?? '')}</div>
      <div class="body">${esc(m.body)}</div>
    </div>`).join('');
  $('msgList').lastElementChild?.scrollIntoView({ block: 'end' });
}

$('msgSend').addEventListener('click', sendMessage);
$('msgInput').addEventListener('keydown', (e) => e.key === 'Enter' && sendMessage());
async function sendMessage() {
  const body = $('msgInput').value.trim();
  if (!body || !state.thread) return;
  $('msgInput').value = '';
  await apiFetch(`/threads/${state.thread.id}/messages`, {
    method: 'POST', body: JSON.stringify({ body }),
  });
  loadMessages();
}

// ----------------------------------------------------------------
// SOS
// ----------------------------------------------------------------

$('sosBtn').addEventListener('click', async () => {
  if (!confirm('Send SOS to your parents right now?')) return;
  $('sosStatus').textContent = 'Sending…';
  const location = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null), { timeout: 3000 },
    );
  });
  try {
    await apiFetch('/sos', { method: 'POST', body: JSON.stringify({ location }) });
    $('sosStatus').textContent = '✅ Sent. Your parents have been alerted.';
  } catch {
    $('sosStatus').textContent = '⚠️ Could not send — find an adult or call.';
  }
});

async function pollSos() {
  if (!isParent()) return;
  try {
    const { alerts } = await apiFetch('/sos/active');
    const banner = $('sosBanner');
    if (!alerts.length) return banner.classList.add('hidden');
    const a = alerts[0];
    const maps = a.location ? ` · <a style="color:#fecaca" href="https://maps.apple.com/?ll=${a.location.lat},${a.location.lng}">map</a>` : '';
    banner.innerHTML = `<div class="info"><b>🆘 ${esc(a.memberName)} needs you</b>
      <small>${esc(a.message ?? 'SOS pressed')} · ${new Date(a.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${maps}</small></div>
      <button data-id="${a.id}">I'm on it</button>`;
    banner.classList.remove('hidden');
    banner.querySelector('button').addEventListener('click', async (e) => {
      await apiFetch(`/sos/${e.target.dataset.id}/ack`, { method: 'POST' });
      pollSos();
    });
  } catch { /* transient */ }
}

// ----------------------------------------------------------------
// Admin
// ----------------------------------------------------------------

async function loadAdmin() {
  loadCalendars();
  $('memberList').innerHTML = state.members.map((m) => {
    const login = m.email ? esc(m.email)
      : m.authUserId ? `signs in as “${esc(m.displayName.toLowerCase())}”` : 'no login';
    return `<div class="memberRow"><i style="background:${m.color}"></i>${esc(m.displayName)}
      <span class="role">${m.role === 'admin' ? 'parent' : m.role} · ${login}</span></div>`;
  }).join('');
}

$('addMemberForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { member, signInName } = await apiFetch('/members', {
      method: 'POST',
      body: JSON.stringify({
        displayName: $('amName').value.trim(),
        role: $('amRole').value,
        color: $('amColor').value,
        email: $('amEmail').value.trim() || undefined,
        password: $('amPassword').value || undefined,
      }),
    });
    state.members.push(member);
    e.target.reset();
    loadAdmin();
    toast(signInName
      ? `${member.displayName} added — signs in as “${signInName}” ✓`
      : `${member.displayName} added ✓`);
  } catch (err) { toast(err.message); }
});

async function loadCalendars() {
  const { calendars } = await apiFetch('/calendars');
  $('calList').innerHTML = calendars.map((cal) => `
    <div class="memberRow"><i style="background:${cal.color ?? '#666'}"></i>${esc(cal.name)}
      <span class="role">${cal.provider === 'ics' ? 'link' : cal.provider}${cal.access === 'read_only' ? ' · view-only' : ''}
      ${cal.provider === 'ics' ? `<button data-cal="${cal.id}" style="background:none;color:var(--red);padding:2px 6px">✕</button>` : ''}</span></div>`).join('');
  $('calList').querySelectorAll('button[data-cal]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remove this calendar and its events from the hub?')) return;
      await apiFetch(`/calendars/${b.dataset.cal}`, { method: 'DELETE' });
      loadCalendars();
    }));
}

$('addCalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'Checking link…';
  try {
    const { imported } = await apiFetch('/calendars/from-url', {
      method: 'POST',
      body: JSON.stringify({
        url: $('acUrl').value.trim(),
        name: $('acName').value.trim() || undefined,
        color: $('acColor').value,
      }),
    });
    e.target.reset();
    loadCalendars();
    toast(`Calendar added — ${imported} events imported ✓`);
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = 'Add calendar'; }
});

$('pairBtn').addEventListener('click', async () => {
  const { code } = await apiFetch('/devices/pairing-code', {
    method: 'POST',
    body: JSON.stringify({ kind: 'apple_tv', name: 'Home display' }),
  });
  $('pairResult').textContent = code;
});

// ----------------------------------------------------------------
// Web Push
// ----------------------------------------------------------------

async function updateNotifBar() {
  const bar = $('notifBar');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return bar.classList.add('hidden');
  // iOS: push only works once installed to the Home Screen
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (isIOS && !installed) {
    $('notifMsg').textContent = 'For notifications: tap Share → “Add to Home Screen”, then open from there.';
    $('notifBtn').classList.add('hidden');
    return bar.classList.remove('hidden');
  }
  if (Notification.permission === 'granted' && (await currentSubscription())) {
    return bar.classList.add('hidden');
  }
  bar.classList.remove('hidden');
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

$('notifBtn').addEventListener('click', async () => {
  try {
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications blocked in settings.');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uToBytes(CFG.VAPID_PUBLIC_KEY),
    });
    await apiFetch('/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    toast('Notifications on ✓');
    updateNotifBar();
  } catch (err) { toast(`Could not enable: ${err.message}`); }
});

function b64uToBytes(b64u) {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// ----------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('signinErr').textContent = '';
  try {
    await signIn($('email').value.trim(), $('password').value);
    boot();
  } catch (err) { $('signinErr').textContent = err.message; }
});

$('signout').addEventListener('click', showSignin);

boot();
