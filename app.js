/* Family Hub PWA — vanilla JS, no build step. Black & gold theme,
   iOS-style day grid with side-by-side overlapping events. */
'use strict';

const CFG = window.HUB_CONFIG;
const API = `${CFG.SUPABASE_URL}/functions/v1/api/api`;
const AUTH = `${CFG.SUPABASE_URL}/auth/v1`;

const $ = (id) => document.getElementById(id);
const state = {
  me: null, members: [], restrictions: null, thread: null, tab: 'today',
  selectedDay: startOfDay(new Date()),
  weekEvents: [], weekKey: null,
  defaultCalendarId: null, pickedMembers: new Set(),
};

// ----------------------------------------------------------------
// Auth (Supabase password grant + refresh)
// ----------------------------------------------------------------

const session = {
  get access() { return localStorage.getItem('hub_at'); },
  get refresh() { return localStorage.getItem('hub_rt'); },
  save(s) { localStorage.setItem('hub_at', s.access_token); localStorage.setItem('hub_rt', s.refresh_token); },
  clear() { localStorage.removeItem('hub_at'); localStorage.removeItem('hub_rt'); },
};

// Kids sign in with just their name — map anything without an "@" to the
// hidden internal address (must match nameToLogin in the backend).
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
  $('addEventBtn').classList.add('hidden');
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
const canAddEvents = () =>
  state.me && (state.me.role !== 'child' || (state.restrictions?.canCreateEvents ?? true));

function buildTabs() {
  // SOS is on every profile — parents get Admin as a fifth tab
  const tabs = [
    { id: 'today', label: 'Today', icon: '📅' },
    { id: 'lists', label: 'Lists', icon: '📝' },
    { id: 'messages', label: 'Messages', icon: '💬' },
    { id: 'sos', label: 'SOS', icon: '🆘' },
    ...(isParent() ? [{ id: 'admin', label: 'Admin', icon: '⚙️' }] : []),
  ];
  $('tabs').innerHTML = tabs.map((t) =>
    `<button data-tab="${t.id}"><span class="ic">${t.icon}</span>${t.label}</button>`).join('');
  $('tabs').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('sosHint').textContent = isParent()
    ? 'Press to alert the rest of the family instantly.'
    : 'Press if you need Mom or Dad right away. They get an instant alert on their phones.';
}

function switchTab(tab) {
  state.tab = tab;
  for (const view of ['today', 'lists', 'messages', 'sos', 'admin']) {
    $(`view-${view}`).classList.toggle('hidden', view !== tab);
  }
  $('composer').classList.toggle('hidden', tab !== 'messages');
  $('addEventBtn').classList.toggle('hidden', tab !== 'today' || !canAddEvents());
  $('tabs').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'today') renderDayView();
  if (tab === 'lists') loadLists();
  if (tab === 'messages') loadMessages();
  if (tab === 'admin') loadAdmin();
}

// ----------------------------------------------------------------
// TV / big-screen mode: fullscreen, larger type, auto-refresh
// ----------------------------------------------------------------

let tvTimer = null;
let wakeLock = null;

async function enterTv() {
  document.body.classList.add('tv');
  $('exitTv').classList.remove('hidden');
  switchTab('today');
  try { await document.documentElement.requestFullscreen?.(); } catch { /* iOS Safari: no API, zoom still applies */ }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  tvTimer = setInterval(() => {
    // follow the real day across midnight, then re-render fresh data
    state.selectedDay = startOfDay(new Date());
    renderDayView(true);
  }, 5 * 60_000);
}

function exitTv() {
  document.body.classList.remove('tv');
  $('exitTv').classList.add('hidden');
  clearInterval(tvTimer); tvTimer = null;
  wakeLock?.release().catch(() => {}); wakeLock = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

$('tvBtn').addEventListener('click', enterTv);
$('exitTv').addEventListener('click', exitTv);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('tv')) exitTv();
});

// ----------------------------------------------------------------
// Lists: grocery + per-member tasks
// ----------------------------------------------------------------

async function loadLists() {
  const [{ items }, { tasks }] = await Promise.all([
    apiFetch('/grocery'), apiFetch('/tasks'),
  ]);

  $('groceryList').innerHTML = items.map((it) => `
    <div class="checkRow">
      <button class="tick" data-g="${it.id}" aria-label="check off"></button>
      <div class="what">${esc(it.name)}
        <div class="byline">added by ${esc(it.addedByName ?? '')}</div></div>
    </div>`).join('') || '<div class="allDone">List is empty 🎉</div>';
  $('groceryList').querySelectorAll('button[data-g]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.closest('.checkRow').style.opacity = '0.35';
      await apiFetch(`/grocery/${b.dataset.g}/check`, { method: 'POST' });
      loadLists();
    }));

  // tasks grouped per family member — everyone sees every list
  const byMember = new Map(state.members.map((m) => [m.id, []]));
  for (const t of tasks) byMember.get(t.memberId)?.push(t);
  $('taskGroups').innerHTML = state.members.map((m) => {
    const list = byMember.get(m.id) ?? [];
    return `<div class="taskGroup">
      <h4><i style="background:${m.color}"></i>${esc(m.displayName)}${m.id === state.me.id ? ' (you)' : ''}</h4>
      ${list.map((t) => `
        <div class="checkRow">
          <button class="tick" data-t="${t.id}" aria-label="mark done"></button>
          <div class="what">${esc(t.title)}</div>
        </div>`).join('') || '<div class="allDone">All done ✓</div>'}
    </div>`;
  }).join('');
  $('taskGroups').querySelectorAll('button[data-t]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.closest('.checkRow').style.opacity = '0.35';
      await apiFetch(`/tasks/${b.dataset.t}/complete`, { method: 'POST' });
      loadLists();
    }));

  // only parents see the assign form
  $('addTaskForm').classList.toggle('hidden', !isParent());
  if (isParent()) {
    $('tMember').innerHTML = state.members.map((m) =>
      `<option value="${m.id}">${esc(m.displayName)}</option>`).join('');
  }
}

$('addGroceryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('gName').value.trim();
  if (!name) return;
  $('gName').value = '';
  await apiFetch('/grocery', { method: 'POST', body: JSON.stringify({ name }) });
  loadLists();
});

$('addTaskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('tTitle').value.trim();
  if (!title) return;
  try {
    await apiFetch('/tasks', {
      method: 'POST',
      body: JSON.stringify({ title, memberId: $('tMember').value }),
    });
    $('tTitle').value = '';
    toast('Task assigned ✓');
    loadLists();
  } catch (err) { toast(err.message); }
});

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.style.opacity = '1';
  setTimeout(() => (el.style.opacity = '0'), 2800);
}

// ----------------------------------------------------------------
// Day view: strip + all-day chips + time grid with overlap columns
// ----------------------------------------------------------------

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
const DAY_MS = 86400_000;
const PX_PER_MIN = 1; // 60px per hour

async function loadWeekEvents() {
  // fetch a 15-day window covering the strip; cache per window
  const from = startOfDay(new Date());
  const to = new Date(from.getTime() + 15 * DAY_MS);
  const key = from.toISOString().slice(0, 10);
  if (state.weekKey === key && state.weekEvents.length) return;
  const { events } = await apiFetch(
    `/events?from=${from.toISOString()}&to=${to.toISOString()}`);
  state.weekEvents = events;
  state.weekKey = key;
}

async function renderDayView(force = false) {
  if (force) state.weekKey = null;
  await loadWeekEvents();
  renderDayStrip();
  renderDayGrid();
}

function renderDayStrip() {
  const today = startOfDay(new Date());
  const days = [...Array(14)].map((_, i) => new Date(today.getTime() + i * DAY_MS));
  $('dayStrip').innerHTML = days.map((d) => `
    <button class="dayPill ${d.getTime() === state.selectedDay.getTime() ? 'sel' : ''}" data-ts="${d.getTime()}">
      <small>${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</small><b>${d.getDate()}</b>
    </button>`).join('');
  $('dayStrip').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.selectedDay = new Date(+b.dataset.ts);
      renderDayStrip(); renderDayGrid();
    }));
  const sel = state.selectedDay;
  const today0 = startOfDay(new Date()).getTime();
  const label = sel.getTime() === today0 ? 'Today'
    : sel.getTime() === today0 + DAY_MS ? 'Tomorrow'
    : sel.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('dayTitle').textContent = `${label} — ${sel.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

function eventsOn(day) {
  const key = localDateKey(day);
  const next = new Date(day.getTime() + DAY_MS);
  return state.weekEvents.filter((e) => {
    if (e.isAllDay) return e.startsAt.slice(0, 10) <= key && key < e.endsAt.slice(0, 10);
    return new Date(e.startsAt) < next && new Date(e.endsAt) > day;
  });
}

function renderDayGrid() {
  const day = state.selectedDay;
  const colorOf = Object.fromEntries(state.members.map((m) => [m.id, m.color]));
  const events = eventsOn(day);

  // all-day chips (like the iOS bar at the top)
  const allDay = events.filter((e) => e.isAllDay);
  $('allDayRow').innerHTML = allDay.map((e) =>
    `<span class="chip" style="--c:${e.color ?? 'var(--accent)'}">${esc(e.title)}</span>`).join('');

  // timed events → clamp to the day, layout overlap columns
  const dayStart = day.getTime();
  const timed = events.filter((e) => !e.isAllDay).map((e) => {
    const s = Math.max(new Date(e.startsAt).getTime(), dayStart);
    const en = Math.min(new Date(e.endsAt).getTime(), dayStart + DAY_MS);
    return { ...e, _s: s, _e: Math.max(en, s + 15 * 60_000) }; // min 15-min block
  }).sort((a, b) => a._s - b._s || b._e - a._e);
  layoutColumns(timed);

  // grid range: 7am–9pm, stretched to fit events
  let firstH = 7, lastH = 21;
  for (const e of timed) {
    firstH = Math.min(firstH, new Date(e._s).getHours());
    lastH = Math.max(lastH, new Date(e._e - 1).getHours() + 1);
  }
  const gridTop = dayStart + firstH * 3600_000;
  const height = (lastH - firstH) * 60 * PX_PER_MIN;

  let html = '';
  for (let h = firstH; h <= lastH; h++) {
    const y = (h - firstH) * 60 * PX_PER_MIN;
    const hr = ((h + 11) % 12) + 1;
    html += `<div class="hourLine" style="top:${y}px"></div>
             <div class="hourLabel" style="top:${y}px">${h === 12 ? 'Noon' : hr + (h < 12 ? ' AM' : ' PM')}</div>`;
  }
  const now = Date.now();
  if (now >= gridTop && now <= gridTop + height * 60_000 / PX_PER_MIN) {
    html += `<div class="nowLine" style="top:${(now - gridTop) / 60_000 * PX_PER_MIN}px"></div>`;
  }
  for (const e of timed) {
    const top = (e._s - gridTop) / 60_000 * PX_PER_MIN;
    const h = (e._e - e._s) / 60_000 * PX_PER_MIN;
    const width = 100 / e._cols;
    const left = e._col * width;
    html += `<div class="gridEv" style="top:${top}px;height:${Math.max(h - 2, 22)}px;left:${left}%;width:calc(${width}% - 3px);--c:${e.color ?? 'var(--accent)'}">
      <div class="t">${fmtTime(e._s)}–${fmtTime(e._e)}</div>
      <div class="n">${esc(e.title)}</div>
      ${(e.memberIds ?? []).length ? `<div class="dots">${e.memberIds.map((id) =>
        `<i style="background:${colorOf[id] ?? '#666'}"></i>`).join('')}</div>` : ''}
    </div>`;
  }
  $('timeGrid').style.height = `${height}px`;
  $('timeGrid').innerHTML = html;
}

/** Assign overlap columns (the iOS side-by-side layout): greedy interval packing. */
function layoutColumns(events) {
  let cols = [];      // cols[i] = end time of the latest event in column i
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const n = cluster.length ? Math.max(...cluster.map((e) => e._col)) + 1 : 0;
    cluster.forEach((e) => (e._cols = n));
    cluster = []; cols = [];
  };
  for (const e of events) {
    if (e._s >= clusterEnd) flush();
    let c = 0;
    while ((cols[c] ?? -Infinity) > e._s) c++;
    e._col = c;
    cols[c] = e._e;
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e._e);
  }
  flush();
}

const localDateKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

// ----------------------------------------------------------------
// Custom events (composer sheet)
// ----------------------------------------------------------------

$('addEventBtn').addEventListener('click', async () => {
  if (!state.defaultCalendarId) {
    const { calendars } = await apiFetch('/calendars');
    state.defaultCalendarId =
      (calendars.find((c) => c.isDefault) ?? calendars.find((c) => c.provider === 'local'))?.id;
  }
  $('evDate').value = localDateKey(state.selectedDay);
  state.pickedMembers = new Set([state.me.id]);
  renderMemberChips();
  $('eventModal').classList.remove('hidden');
});

function renderMemberChips() {
  $('memberChips').innerHTML = state.members.map((m) => `
    <button type="button" data-m="${m.id}" class="${state.pickedMembers.has(m.id) ? 'on' : ''}"
      style="--c:${m.color}">${esc(m.displayName)}</button>`).join('');
  $('memberChips').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.m;
      state.pickedMembers.has(id) ? state.pickedMembers.delete(id) : state.pickedMembers.add(id);
      renderMemberChips();
    }));
}

$('evCancel').addEventListener('click', () => $('eventModal').classList.add('hidden'));
$('eventModal').addEventListener('click', (e) => {
  if (e.target === $('eventModal')) $('eventModal').classList.add('hidden');
});

$('eventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = $('evDate').value;
  const allDay = !!$('evAllDay').value;
  const startsAt = allDay ? `${date}T00:00:00Z` : new Date(`${date}T${$('evStart').value}`).toISOString();
  const endsAt = allDay
    ? `${localDateKey(new Date(new Date(`${date}T12:00`).getTime() + DAY_MS))}T00:00:00Z`
    : new Date(`${date}T${$('evEnd').value}`).toISOString();
  if (endsAt <= startsAt) return toast('End time must be after start time.');
  try {
    await apiFetch('/events', {
      method: 'POST',
      body: JSON.stringify({
        calendarId: state.defaultCalendarId,
        title: $('evTitle').value.trim(),
        startsAt, endsAt,
        isAllDay: allDay,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        rrule: $('evRepeat').value || null,
        color: state.members.find((m) => m.id === [...state.pickedMembers][0])?.color ?? null,
        memberIds: [...state.pickedMembers],
      }),
    });
    $('eventModal').classList.add('hidden');
    $('eventForm').reset();
    toast('Event added ✓');
    renderDayView(true);
  } catch (err) { toast(err.message); }
});

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
// SOS — every profile has it
// ----------------------------------------------------------------

$('sosBtn').addEventListener('click', async () => {
  if (!confirm('Send SOS to the family right now?')) return;
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
    $('sosStatus').textContent = '✅ Sent. The family has been alerted.';
  } catch {
    $('sosStatus').textContent = '⚠️ Could not send — find an adult or call.';
  }
});

async function pollSos() {
  if (!isParent()) return;
  try {
    const { alerts } = await apiFetch('/sos/active');
    const banner = $('sosBanner');
    const others = alerts.filter((a) => a.memberId !== state.me.id);
    if (!others.length) return banner.classList.add('hidden');
    const a = others[0];
    const maps = a.location ? ` · <a style="color:#fecaca" href="https://maps.apple.com/?ll=${a.location.lat},${a.location.lng}">map</a>` : '';
    banner.innerHTML = `<div class="info"><b>🆘 ${esc(a.memberName)} needs you</b>
      <small>${esc(a.message ?? 'SOS pressed')} · ${fmtTime(a.createdAt)}${maps}</small></div>
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
  const btn = e.target.querySelector('button[type=submit]');
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
    state.weekKey = null; // refresh the day view cache
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = 'Add calendar'; }
});

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
