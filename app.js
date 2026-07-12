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
  view: localStorage.getItem('hub_view') === 'week' ? 'week' : 'day',
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
  $('vaultBtn').classList.add('hidden');
  $('vaultView').classList.add('hidden');
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
    maybeShowVaultButton();
    loadEarnings();
    loadCountdowns();
    pollSos();
    setInterval(pollSos, 20_000);
    syncWakeLock(); // big screens: hold the display awake from sign-in
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
    { id: 'messages', label: 'Chat', icon: '💬' },
    { id: 'games', label: 'Games', icon: '🎲' },
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
  for (const view of ['today', 'lists', 'messages', 'games', 'sos', 'admin']) {
    $(`view-${view}`).classList.toggle('hidden', view !== tab);
  }
  $('composer').classList.toggle('hidden', tab !== 'messages');
  $('addEventBtn').classList.toggle('hidden', tab !== 'today' || !canAddEvents());
  $('tabs').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'today') { renderDayView(); loadTodayChores(); }
  if (tab === 'lists') loadLists();
  if (tab === 'messages') loadMessages();
  if (tab === 'admin') loadAdmin();
}

// ----------------------------------------------------------------
// Wake lock — keep TVs/computers from sleeping while the hub runs.
// Held whenever: TV mode is on, the screensaver is up, or the app is
// on a big screen. Re-acquired when the tab becomes visible again.
// ----------------------------------------------------------------

let wakeLock = null;
const isBigScreen = () => matchMedia('(min-width: 900px)').matches;

async function syncWakeLock() {
  const want = document.body.classList.contains('tv') || saver.active || isBigScreen();
  if (want && !wakeLock && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
      wakeLock?.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not supported / power settings deny — screensaver motion still helps */ }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {}); wakeLock = null;
  }
}
document.addEventListener('visibilitychange', syncWakeLock);

// ----------------------------------------------------------------
// TV / big-screen mode: fullscreen, larger type, auto-refresh
// ----------------------------------------------------------------

let tvTimer = null;

async function enterTv() {
  document.body.classList.add('tv');
  $('exitTv').classList.remove('hidden');
  switchTab('today');
  try { await document.documentElement.requestFullscreen?.(); } catch { /* iOS Safari: no API, zoom still applies */ }
  syncWakeLock();
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
  syncWakeLock();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

// ----------------------------------------------------------------
// Screensaver — after 30 min idle: a sun arcs across the screen;
// from 9pm (to 6am) night mode swaps in a moon over a starfield.
// One full horizon-to-horizon arc every 15 minutes. The motion
// prevents burn-in; the wake lock prevents sleep.
// ----------------------------------------------------------------

const IDLE_MS = 30 * 60_000;      // screensaver after 30 minutes
const ARC_MS = 15 * 60_000;       // one arc pass every 15 minutes
const NIGHT_START = 21, NIGHT_END = 6; // 9pm → 6am

const saver = { active: false, raf: null, clockTimer: null, forceNight: null, shownAt: 0 };
let lastActivity = Date.now();

const isNightNow = () => {
  if (saver.forceNight !== null) return saver.forceNight;
  const h = new Date().getHours();
  return h >= NIGHT_START || h < NIGHT_END;
};

function showSaver(forceNight = null) {
  if (saver.active) return;
  saver.active = true;
  saver.shownAt = Date.now();
  saver.forceNight = forceNight;
  saverMouse = null;
  $('saver').classList.remove('hidden');
  applySaverMode();
  syncWakeLock();
  const animate = () => {
    if (!saver.active) return;
    positionCelestial();
    saver.raf = requestAnimationFrame(animate);
  };
  animate();
  saver.clockTimer = setInterval(() => {
    tickSaverClock();
    applySaverMode();      // flips sun→moon live at 9pm
    positionCelestial();   // guarantees motion even if rAF is throttled
    if (new Date().getSeconds() === 0) renderSaverExtras(); // weather/countdowns refresh
  }, 1000);
  tickSaverClock();
  renderSaverExtras();
}

/** Wake requests from user input — filtered so the screensaver doesn't
 *  vanish from the click that started it or an accidental mouse nudge. */
function requestWake() {
  if (!saver.active) return;
  if (Date.now() - saver.shownAt < 2500) return; // grace after starting
  hideSaver();
}

function hideSaver() {
  if (!saver.active) return;
  saver.active = false;
  saver.forceNight = null;
  $('saver').classList.add('hidden');
  cancelAnimationFrame(saver.raf);
  clearInterval(saver.clockTimer);
  syncWakeLock();
  renderDayView(true); // fresh data when the family comes back
}

function applySaverMode() {
  const night = isNightNow();
  $('saver').classList.toggle('night', night);
  $('celestial').className = night ? 'moon' : 'sun';
  const wantStars = night ? 60 : 0;
  const stars = $('saver').querySelectorAll('.star');
  if (stars.length !== wantStars) {
    stars.forEach((s) => s.remove());
    for (let i = 0; i < wantStars; i++) {
      const s = document.createElement('div');
      s.className = 'star';
      s.style.left = `${Math.random() * 100}%`;
      s.style.top = `${Math.random() * 70}%`;
      s.style.animationDelay = `${Math.random() * 4}s`;
      $('saver').appendChild(s);
    }
  }
}

/** Sun/moon position: horizon → zenith → horizon, one pass per 15 min. */
function positionCelestial() {
  const t = (Date.now() % ARC_MS) / ARC_MS;         // 0 → 1 across the pass
  const el = $('celestial');
  const size = el.offsetWidth;
  const w = innerWidth + size * 2;
  const x = t * w - size;                            // enters left, exits right
  const horizon = innerHeight * 0.91;                // matches #saverHorizon
  const peak = innerHeight * 0.62;                   // arc height
  const y = horizon - Math.sin(t * Math.PI) * peak - size;
  el.style.transform = `translate(${x - size}px, ${y}px)`;
}

function tickSaverClock() {
  const now = new Date();
  $('saverClock').innerHTML = `${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
    <small>${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</small>`;
}

/** Bowling Green weather + the next countdowns, under the clock. */
async function renderSaverExtras() {
  const parts = [];
  const w = await getWeather();
  if (w) parts.push(`${w.tempF}° ${w.text}`);
  for (const cd of (state.countdowns ?? []).slice(0, 2)) {
    const d = daysUntil(cd.targetDate);
    parts.push(d === 0 ? `🎉 ${esc(cd.label)} is today!`
      : `${esc(cd.label)} in ${d} day${d === 1 ? '' : 's'}`);
  }
  $('saverExtras').innerHTML = parts.map((p) => `<span>${p}</span>`).join('<span>·</span>');
}

// idle detection: any interaction resets the 30-minute clock.
// Taps/keys wake the screensaver immediately (after the start grace);
// mouse movement only wakes it after ~60px of deliberate motion, so a
// desk bump or mouse drift doesn't kill it.
for (const evt of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
  addEventListener(evt, () => {
    lastActivity = Date.now();
    requestWake();
  }, { passive: true });
}
let lastMouse = 0;
let saverMouse = null; // movement accumulator while the saver is up
addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastMouse > 1000) { lastMouse = now; lastActivity = now; }
  if (!saver.active) { saverMouse = null; return; }
  if (!saverMouse) { saverMouse = { x: e.clientX, y: e.clientY, dist: 0 }; return; }
  saverMouse.dist += Math.hypot(e.clientX - saverMouse.x, e.clientY - saverMouse.y);
  saverMouse.x = e.clientX; saverMouse.y = e.clientY;
  if (saverMouse.dist > 60) requestWake();
}, { passive: true });

setInterval(() => {
  if (!saver.active && session.access && Date.now() - lastActivity >= IDLE_MS) showSaver();
}, 30_000);

// manual sleep: start the screensaver on demand (sun/moon follows the clock)
$('sleepBtn').addEventListener('click', () => {
  try { showSaver(); } catch (err) { toast(`Screensaver failed: ${err.message}`); }
});

// manual/testing hook: window.hubSaver.show(true) previews night mode
window.hubSaver = { show: showSaver, hide: hideSaver };

$('tvBtn').addEventListener('click', enterTv);
$('exitTv').addEventListener('click', exitTv);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('tv')) exitTv();
});

// ----------------------------------------------------------------
// Weather + sun times (Bowling Green, KY) — Open-Meteo, no key.
// Drives the daylight theme and the screensaver's weather line.
// ----------------------------------------------------------------

const WX_URL = 'https://api.open-meteo.com/v1/forecast?latitude=36.99&longitude=-86.443'
  + '&current=temperature_2m,weather_code&daily=sunrise,sunset'
  + '&temperature_unit=fahrenheit&timezone=America%2FChicago&forecast_days=1';
const WX_TEXT = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Foggy', 48: 'Foggy',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers',
  86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};
let wx = null;

async function getWeather() {
  if (wx && Date.now() - wx.fetchedAt < 30 * 60_000) return wx;
  try {
    const r = await (await fetch(WX_URL)).json();
    wx = {
      tempF: Math.round(r.current.temperature_2m),
      text: WX_TEXT[r.current.weather_code] ?? '',
      sunrise: new Date(r.daily.sunrise[0]).getTime(),
      sunset: new Date(r.daily.sunset[0]).getTime(),
      fetchedAt: Date.now(),
    };
  } catch { /* offline: keep last reading */ }
  return wx;
}

/** Light beige/blue theme sunrise→sunset; gold/black after sundown. */
async function updateTheme() {
  const w = await getWeather();
  const now = Date.now();
  const isDay = w
    ? now >= w.sunrise && now < w.sunset
    : (() => { const h = new Date().getHours(); return h >= 7 && h < 20; })(); // offline fallback
  document.body.classList.toggle('daylight', isDay);
}
updateTheme();
setInterval(updateTheme, 60_000);

// ----------------------------------------------------------------
// Countdowns — admin-managed, shown on the screensaver
// ----------------------------------------------------------------

async function loadCountdowns() {
  try {
    const { countdowns } = await apiFetch('/countdowns');
    state.countdowns = countdowns;
    if (isParent()) renderCountdownAdmin();
  } catch { /* transient */ }
}

const daysUntil = (dateStr) =>
  Math.ceil((new Date(`${dateStr}T00:00`) - startOfDay(new Date())) / DAY_MS);

function renderCountdownAdmin() {
  $('cdList').innerHTML = (state.countdowns ?? []).map((cd) => {
    const d = daysUntil(cd.targetDate);
    return `<div class="memberRow">⏳ ${esc(cd.label)}
      <span class="role">${d === 0 ? 'today!' : `${d} day${d === 1 ? '' : 's'}`}
      <button data-cd="${cd.id}" style="background:none;color:var(--red);padding:2px 6px">✕</button></span></div>`;
  }).join('') || '<div class="allDone">No countdowns yet.</div>';
  $('cdList').querySelectorAll('button[data-cd]').forEach((b) =>
    b.addEventListener('click', async () => {
      await apiFetch(`/countdowns/${b.dataset.cd}`, { method: 'DELETE' });
      loadCountdowns();
    }));
}

$('addCdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiFetch('/countdowns', {
      method: 'POST',
      body: JSON.stringify({ label: $('cdLabel').value.trim(), targetDate: $('cdDate').value }),
    });
    e.target.reset();
    toast('Countdown added ✓');
    loadCountdowns();
  } catch (err) { toast(err.message); }
});

// ----------------------------------------------------------------
// Meal plan — next 7 dinners; ingredients push to the grocery list
// ----------------------------------------------------------------

async function loadMeals() {
  const from = localDateKey(new Date());
  const to = localDateKey(new Date(Date.now() + 6 * DAY_MS));
  const { meals } = await apiFetch(`/meals?from=${from}&to=${to}`);
  const byDate = Object.fromEntries(meals.map((m) => [m.mealDate, m]));
  const canEdit = state.me.role !== 'child';
  const days = [...Array(7)].map((_, i) => new Date(Date.now() + i * DAY_MS));

  $('mealList').innerHTML = days.map((d) => {
    const key = localDateKey(d);
    const meal = byDate[key];
    const label = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    if (!canEdit) {
      return `<div class="mealRow"><span class="mealDay">${label}</span>
        <span class="mealRead">${meal ? esc(meal.title) : '<span style="color:var(--dim)">—</span>'}</span></div>`;
    }
    return `<div class="mealRow"><span class="mealDay">${label}</span>
        <input class="mTitle" data-date="${key}" value="${esc(meal?.title ?? '')}" placeholder="Dinner…">
        ${meal?.ingredients ? `<button class="cart" data-cart="${key}" title="Send ingredients to grocery list">🛒</button>` : ''}
      </div>
      <input class="mIng" data-date="${key}" value="${esc(meal?.ingredients ?? '')}"
        placeholder="ingredients, comma separated">`;
  }).join('');
  $('mealNote').classList.toggle('hidden', !canEdit);

  const save = async (key) => {
    const title = $('mealList').querySelector(`.mTitle[data-date="${key}"]`).value.trim();
    const ingredients = $('mealList').querySelector(`.mIng[data-date="${key}"]`).value.trim();
    await apiFetch(`/meals/${key}`, {
      method: 'PUT', body: JSON.stringify({ title, ingredients }),
    });
    loadMeals();
  };
  $('mealList').querySelectorAll('.mTitle, .mIng').forEach((el) =>
    el.addEventListener('change', () => save(el.dataset.date)));
  $('mealList').querySelectorAll('button[data-cart]').forEach((b) =>
    b.addEventListener('click', async () => {
      const names = ($('mealList').querySelector(`.mIng[data-date="${b.dataset.cart}"]`).value)
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (!names.length) return;
      await apiFetch('/grocery', { method: 'POST', body: JSON.stringify({ names }) });
      toast(`${names.length} ingredient${names.length === 1 ? '' : 's'} → grocery list ✓`);
      loadLists();
    }));
}

// ----------------------------------------------------------------
// Earnings (allowance): chips on the main screen, admin card
// ----------------------------------------------------------------

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

async function loadEarnings() {
  try {
    const { balances, recent } = await apiFetch('/earnings');
    state.balances = Object.fromEntries(balances.map((b) => [b.memberId, b.balanceCents]));
    state.earnHistory = recent;
    renderEarnStrip();
    if (isParent()) renderEarnAdmin();
  } catch { /* transient */ }
}

function renderEarnStrip() {
  // kids always show; adults only if they have a balance
  const show = state.members.filter((m) =>
    m.role === 'child' || (state.balances?.[m.id] ?? 0) !== 0);
  $('earnStrip').innerHTML = show.map((m) => `
    <span class="earnChip"><i style="background:${m.color}"></i>${esc(m.displayName)}
      <b>${money(state.balances?.[m.id] ?? 0)}</b></span>`).join('');
}

function renderEarnAdmin() {
  const nameOf = Object.fromEntries(state.members.map((m) => [m.id, m.displayName]));
  $('earnBalances').innerHTML = state.members
    .filter((m) => m.role === 'child' || (state.balances?.[m.id] ?? 0) !== 0)
    .map((m) => `<div class="memberRow"><i style="background:${m.color}"></i>${esc(m.displayName)}
      <span class="role" style="color:var(--accent);font-weight:700">${money(state.balances?.[m.id] ?? 0)}</span></div>`)
    .join('');
  $('ajMember').innerHTML = state.members
    .filter((m) => m.role === 'child' || (state.balances?.[m.id] ?? 0) !== 0)
    .map((m) => `<option value="${m.id}">${esc(m.displayName)}</option>`).join('');
  $('earnHistory').innerHTML = (state.earnHistory ?? []).map((e) => `
    <div class="histRow">
      <span class="amt ${e.amountCents >= 0 ? 'plus' : 'minus'}">${e.amountCents >= 0 ? '+' : '−'}${money(Math.abs(e.amountCents))}</span>
      <span>${esc(nameOf[e.memberId] ?? '')} · ${esc(e.reason ?? '')}</span>
    </div>`).join('');
}

$('adjustForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiFetch('/earnings/adjust', {
      method: 'POST',
      body: JSON.stringify({
        memberId: $('ajMember').value,
        amount: Number($('ajAmount').value),
        note: $('ajNote').value.trim() || undefined,
      }),
    });
    e.target.reset();
    toast('Balance updated ✓');
    loadEarnings();
  } catch (err) { toast(err.message); }
});

// ----------------------------------------------------------------
// Lists: grocery + per-member tasks
// ----------------------------------------------------------------

async function loadLists() {
  loadMeals();
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
          <div class="what">${esc(t.title)}${t.valueCents > 0 ? `<span class="valueBadge">${money(t.valueCents)}</span>` : ''}${t.repeatFreq ? `<span class="byline">🔁 ${t.repeatFreq}</span>` : ''}</div>
        </div>`).join('') || '<div class="allDone">All done ✓</div>'}
    </div>`;
  }).join('');
  $('taskGroups').querySelectorAll('button[data-t]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.closest('.checkRow').style.opacity = '0.35';
      const { task, earnedCents } = await apiFetch(`/tasks/${b.dataset.t}/complete`, { method: 'POST' });
      if (earnedCents > 0) {
        const who = state.members.find((m) => m.id === task.memberId);
        toast(`${who?.id === state.me.id ? 'You' : who?.displayName ?? 'They'} earned ${money(earnedCents)} 🎉`);
        loadEarnings();
      }
      loadLists();
    }));

  // parents assign tasks — plus the richeyhr account by name grant
  const canAssign = isParent() || (state.me.email ?? '').toLowerCase().startsWith('richeyhr');
  $('addTaskForm').classList.toggle('hidden', !canAssign);
  if (canAssign) {
    $('tMember').innerHTML = state.members.map((m) =>
      `<option value="${m.id}">${esc(m.displayName)}</option>`).join('');
  }

  // grocery push recipients
  if (!state.gPushPicked) state.gPushPicked = new Set();
  $('gPushChips').innerHTML = state.members
    .filter((m) => m.id !== state.me.id)
    .map((m) => `<button type="button" data-gp="${m.id}" style="--c:${m.color}"
      class="${state.gPushPicked.has(m.id) ? 'on' : ''}">${esc(m.displayName)}</button>`).join('');
  $('gPushChips').querySelectorAll('button').forEach((b) => {
    b.style.cssText += ';background:var(--panel2);color:var(--dim);border:1px solid var(--line);padding:7px 12px;border-radius:20px;font-size:.85rem';
    if (b.classList.contains('on')) {
      b.style.borderColor = b.style.getPropertyValue('--c');
      b.style.color = 'var(--text)';
    }
    b.addEventListener('click', () => {
      const id = b.dataset.gp;
      state.gPushPicked.has(id) ? state.gPushPicked.delete(id) : state.gPushPicked.add(id);
      loadLists();
    });
  });
}

$('gPushBtn').addEventListener('click', async () => {
  if (!state.gPushPicked?.size) return toast('Pick who should get the list.');
  try {
    const { sent, items } = await apiFetch('/grocery/push', {
      method: 'POST', body: JSON.stringify({ memberIds: [...state.gPushPicked] }),
    });
    toast(`List of ${items} sent to ${sent} ${sent === 1 ? 'person' : 'people'} 📤`);
    state.gPushPicked.clear();
    loadLists();
  } catch (err) { toast(err.message); }
});

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
      body: JSON.stringify({
        title,
        memberId: $('tMember').value,
        value: Number($('tValue').value) || 0,
        repeatFreq: $('tRepeat').value || undefined,
      }),
    });
    $('tTitle').value = ''; $('tValue').value = ''; $('tRepeat').value = '';
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
  // window covers the full current week (may start before today) plus the
  // 14-day strip; cached per calendar day
  const today = startOfDay(new Date());
  const from = new Date(today.getTime() - 7 * DAY_MS);
  const to = new Date(today.getTime() + 21 * DAY_MS);
  const key = today.toISOString().slice(0, 10);
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
  $('viewSeg').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('on', b.dataset.v === state.view));
  const week = state.view === 'week';
  $('allDayRow').classList.toggle('hidden', week);
  $('gridWrap').classList.toggle('hidden', week);
  $('weekGrid').classList.toggle('hidden', !week);
  if (week) renderWeekGrid(); else renderDayGrid();
}

$('viewSeg').querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = b.dataset.v;
    localStorage.setItem('hub_view', state.view);
    renderDayView();
  }));

/** Week view: 7 columns from the selected day's week (Sunday start). */
function renderWeekGrid() {
  const sel = state.selectedDay;
  const weekStart = new Date(sel.getTime() - sel.getDay() * DAY_MS);
  const today = startOfDay(new Date()).getTime();
  const colorOf = Object.fromEntries(state.members.map((m) => [m.id, m.color]));
  const days = [...Array(7)].map((_, i) => new Date(weekStart.getTime() + i * DAY_MS));

  state.weekCells = days.map((day) => {
    const evs = eventsOn(day)
      .sort((a, b) => (b.isAllDay - a.isAllDay) || a.startsAt.localeCompare(b.startsAt));
    return { day, evs };
  });

  $('dayTitle').textContent = `Week of ${weekStart.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
  $('weekGrid').innerHTML = state.weekCells.map(({ day, evs }, di) => `
    <div class="wkDay ${day.getTime() === today ? 'today' : ''}">
      <h5 data-day="${day.getTime()}">${day.toLocaleDateString(undefined, { weekday: 'short' })}<b>${day.getDate()}</b></h5>
      ${evs.map((e, ei) => `
        <div class="wkEv" data-cell="${di}:${ei}" style="--c:${e.color ?? 'var(--accent)'}">
          <div class="t">${e.isAllDay ? 'all day' : fmtTime(e.startsAt)}</div>
          <div class="n">${esc(e.title)}</div>
          ${(e.memberIds ?? []).length ? `<div class="dots">${e.memberIds.map((id) =>
            `<i style="background:${colorOf[id] ?? '#666'}"></i>`).join('')}</div>` : ''}
        </div>`).join('')}
    </div>`).join('');

  // tap a date → jump into that day; tap an event → details
  $('weekGrid').querySelectorAll('h5[data-day]').forEach((h) =>
    h.addEventListener('click', () => {
      state.selectedDay = new Date(+h.dataset.day);
      state.view = 'day';
      localStorage.setItem('hub_view', 'day');
      renderDayView();
    }));
  $('weekGrid').querySelectorAll('[data-cell]').forEach((el) =>
    el.addEventListener('click', () => {
      const [di, ei] = el.dataset.cell.split(':').map(Number);
      openEventDetail(state.weekCells[di].evs[ei]);
    }));

  // scroll today's column into view on phones
  $('weekGrid').querySelector('.wkDay.today')?.scrollIntoView({ inline: 'center', block: 'nearest' });
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

  // all-day chips (like the iOS bar at the top) — tap to expand
  const allDay = events.filter((e) => e.isAllDay);
  state.dayAllDay = allDay;
  $('allDayRow').innerHTML = allDay.map((e, i) =>
    `<span class="chip" data-ad="${i}" style="--c:${e.color ?? 'var(--accent)'}">${esc(e.title)}</span>`).join('');
  $('allDayRow').querySelectorAll('[data-ad]').forEach((el) =>
    el.addEventListener('click', () => openEventDetail(state.dayAllDay[+el.dataset.ad])));

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
  state.dayTimed = timed;
  timed.forEach((e, i) => {
    const top = (e._s - gridTop) / 60_000 * PX_PER_MIN;
    const h = (e._e - e._s) / 60_000 * PX_PER_MIN;
    const width = 100 / e._cols;
    const left = e._col * width;
    html += `<div class="gridEv" data-ev="${i}" style="top:${top}px;height:${Math.max(h - 2, 22)}px;left:${left}%;width:calc(${width}% - 3px);--c:${e.color ?? 'var(--accent)'}">
      <div class="t">${fmtTime(e._s)}–${fmtTime(e._e)}</div>
      <div class="n">${esc(e.title)}</div>
      ${(e.memberIds ?? []).length ? `<div class="dots">${e.memberIds.map((id) =>
        `<i style="background:${colorOf[id] ?? '#666'}"></i>`).join('')}</div>` : ''}
    </div>`;
  });
  $('timeGrid').style.height = `${height}px`;
  $('timeGrid').innerHTML = html;
  $('timeGrid').querySelectorAll('[data-ev]').forEach((el) =>
    el.addEventListener('click', () => openEventDetail(state.dayTimed[+el.dataset.ev])));
}

// ----------------------------------------------------------------
// Event details sheet — tap any event to expand it
// ----------------------------------------------------------------

const REPEAT_LABELS = {
  DAILY: 'Repeats every day', WEEKLY: 'Repeats every week',
  MONTHLY: 'Repeats every month', YEARLY: 'Repeats every year',
};
const CAL_LABELS = {
  local: 'Family calendar', ics: 'Subscribed calendar · view-only',
  google: 'Google Calendar', outlook: 'Outlook', apple: 'iCloud',
};

function openEventDetail(e) {
  state.detailEvent = e;
  const sheet = $('detailModal');
  sheet.querySelector('.sheet').style.setProperty('--c', e.color ?? 'var(--accent)');
  $('dTitle').textContent = e.title;

  // the event's own date (works from both day and week views)
  const dayLabel = new Date(e._s ?? e.occurrenceStart ?? e.startsAt).toLocaleDateString(
    undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('dWhen').innerHTML = e.isAllDay
    ? `All day<small>${esc(dayLabel)}</small>`
    : `${fmtTime(e._s ?? e.startsAt)} – ${fmtTime(e._e ?? e.endsAt)}<small>${esc(dayLabel)}</small>`;

  const freq = e.rrule?.match(/FREQ=(\w+)/)?.[1];
  toggleRow('dRepeatRow', !!e.rrule);
  if (e.rrule) $('dRepeat').textContent = REPEAT_LABELS[freq] ?? 'Repeating event';

  toggleRow('dLocRow', !!e.location);
  if (e.location) $('dLoc').textContent = e.location;
  toggleRow('dDescRow', !!e.description);
  if (e.description) $('dDesc').textContent = e.description;

  $('dCal').textContent = CAL_LABELS[e.provider] ?? e.provider;

  const members = (e.memberIds ?? [])
    .map((id) => state.members.find((m) => m.id === id)).filter(Boolean);
  toggleRow('dWhoRow', members.length > 0);
  $('dMembers').innerHTML = members.map((m) =>
    `<span><i style="background:${m.color}"></i>${esc(m.displayName)}</span>`).join('');

  // delete: only family-calendar events (feeds are view-only); the server
  // still enforces roles/ownership, so a blocked delete just toasts
  const deletable = e.provider === 'local' && !e.isReadOnly && canAddEvents();
  $('dDelete').classList.toggle('hidden', !deletable);
  sheet.classList.remove('hidden');
}

function toggleRow(id, show) { $(id).classList.toggle('hidden', !show); }

$('dClose').addEventListener('click', () => $('detailModal').classList.add('hidden'));
$('detailModal').addEventListener('click', (e) => {
  if (e.target === $('detailModal')) $('detailModal').classList.add('hidden');
});
$('dDelete').addEventListener('click', async () => {
  const e = state.detailEvent;
  const warning = e.rrule
    ? 'This is a repeating event — deleting removes the whole series. Continue?'
    : `Delete "${e.title}"?`;
  if (!confirm(warning)) return;
  try {
    await apiFetch(`/events/${e.id}`, { method: 'DELETE' });
    $('detailModal').classList.add('hidden');
    toast('Event deleted ✓');
    renderDayView(true);
  } catch (err) { toast(err.message); }
});

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
// Today's chores — kids' open tasks right on the main page.
// A child sees their own list; parents see every kid's. Ticking
// completes (and pays) exactly like the Lists tab.
// ----------------------------------------------------------------

async function loadTodayChores() {
  try {
    const { tasks } = await apiFetch('/tasks');
    const childIds = new Set(state.members.filter((m) => m.role === 'child').map((m) => m.id));
    const mine = state.me.role === 'child'
      ? tasks.filter((t) => t.memberId === state.me.id)
      : tasks.filter((t) => childIds.has(t.memberId));
    const colorOf = Object.fromEntries(state.members.map((m) => [m.id, m.color]));
    const nameOf = Object.fromEntries(state.members.map((m) => [m.id, m.displayName]));

    $('choresToday').innerHTML = mine.length ? `<div class="card">
      <h4>${state.me.role === 'child' ? 'Your tasks' : "Kids' tasks"}</h4>
      ${mine.map((t) => `
        <div class="checkRow">
          <button class="tick" data-ct="${t.id}" aria-label="mark done"></button>
          ${state.me.role !== 'child'
            ? `<span class="who"><i style="background:${colorOf[t.memberId]}"></i>${esc(nameOf[t.memberId] ?? '')}</span>` : ''}
          <div class="what">${esc(t.title)}${t.valueCents > 0 ? `<span class="valueBadge">${money(t.valueCents)}</span>` : ''}</div>
        </div>`).join('')}
    </div>` : '';

    $('choresToday').querySelectorAll('button[data-ct]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.closest('.checkRow').style.opacity = '0.35';
        const { task, earnedCents } = await apiFetch(`/tasks/${b.dataset.ct}/complete`, { method: 'POST' });
        if (earnedCents > 0) {
          const who = state.members.find((m) => m.id === task.memberId);
          toast(`${who?.id === state.me.id ? 'You' : who?.displayName ?? 'They'} earned ${money(earnedCents)} 🎉`);
          loadEarnings();
        }
        loadTodayChores();
      }));
  } catch { /* transient */ }
}

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
  // archive control: vault owner only
  $('chatTools').classList.toggle('hidden', state.me?.email !== VAULT_OWNER_EMAIL);
  const { messages } = await apiFetch(`/threads/${state.thread.id}/messages`);
  $('msgList').innerHTML = messages.map((m) => `
    <div class="msg ${m.senderId === state.me.id ? 'mine' : ''} ${m.isAnnouncement ? 'announce' : ''}">
      <div class="from">${m.isAnnouncement ? '📣 ' : ''}${esc(m.senderName ?? '')}</div>
      <div class="body">${esc(m.body)}</div>
    </div>`).join('');
  $('msgList').lastElementChild?.scrollIntoView({ block: 'end' });
}

$('archiveChatBtn').addEventListener('click', async () => {
  if (!confirm('Archive the whole chat? It clears for everyone; you keep a private copy under 🇺🇸 → Archive.')) return;
  const { archived } = await apiFetch(`/chat/archive/${state.thread.id}`, { method: 'POST' });
  toast(`${archived} messages archived ✓`);
  loadMessages();
});

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
// Games: fun facts, jokes, would-you-rather — fresh on every tap.
// Facts and jokes pull from free public services (with a kid-safety
// filter); everything falls back to bundled packs offline.
// ----------------------------------------------------------------

const FACTS_PACK = [
  'Octopuses have three hearts — and two of them stop beating when they swim.',
  'A group of flamingos is called a "flamboyance."',
  'Honey never spoils. Archaeologists have eaten 3,000-year-old honey from Egyptian tombs.',
  'Your nose can remember about 50,000 different smells.',
  'A day on Venus is longer than a year on Venus.',
  'Sea otters hold hands while they sleep so they don\'t drift apart.',
  'Bananas are berries, but strawberries aren\'t.',
  'The Eiffel Tower grows about 6 inches taller in summer because metal expands in heat.',
  'Sloths can hold their breath longer than dolphins — up to 40 minutes.',
  'There are more trees on Earth than stars in the Milky Way.',
  'A bolt of lightning is five times hotter than the surface of the sun.',
  'Cows have best friends and get stressed when separated.',
  'The wood frog can freeze solid all winter and thaw back to life in spring.',
  'Astronauts grow about 2 inches taller in space.',
  'A snail can sleep for three years straight.',
  'Butterflies taste with their feet.',
  'The heart of a blue whale is the size of a small car.',
  'Kentucky has more miles of underground caves than any other place on Earth — Mammoth Cave!',
];

const JOKES_PACK = [
  'Why don\'t eggs tell jokes?\nThey\'d crack each other up.',
  'What do you call a fish wearing a bowtie?\nSo-fish-ticated.',
  'Why did the math book look sad?\nIt had too many problems.',
  'What do you call cheese that isn\'t yours?\nNacho cheese!',
  'Why can\'t you give Elsa a balloon?\nBecause she\'ll let it go.',
  'What did the ocean say to the beach?\nNothing, it just waved.',
  'Why do bees have sticky hair?\nBecause they use honeycombs.',
  'What\'s brown and sticky?\nA stick.',
  'Why did the scarecrow win an award?\nHe was outstanding in his field.',
  'What do you call a dinosaur that crashes his car?\nTyrannosaurus Wrecks.',
  'How do you make a tissue dance?\nPut a little boogie in it.',
  'What did one wall say to the other wall?\nI\'ll meet you at the corner.',
  'Why did the golfer bring two pairs of pants?\nIn case he got a hole in one.',
  'What do you call a sleeping bull?\nA bulldozer.',
  'Why don\'t scientists trust atoms?\nBecause they make up everything!',
];

const WYR_PACK = [
  ['be able to fly', 'be able to turn invisible'],
  ['have a pet dragon', 'be a dragon'],
  ['eat pizza for every meal', 'eat tacos for every meal'],
  ['live in a treehouse', 'live in a castle'],
  ['talk to animals', 'speak every human language'],
  ['be super fast', 'be super strong'],
  ['have no homework ever', 'have no chores ever'],
  ['visit the Moon', 'visit the bottom of the ocean'],
  ['be a famous athlete', 'be a famous inventor'],
  ['have a robot best friend', 'have a dinosaur best friend'],
  ['only whisper forever', 'only shout forever'],
  ['have spaghetti hair', 'have marshmallow fingers'],
  ['be 10 feet tall', 'be 10 inches tall'],
  ['live where it\'s always summer', 'live where it\'s always snowing'],
  ['ride a giraffe to school', 'ride a rhino to school'],
  ['be able to pause time', 'be able to rewind time'],
  ['have a swimming pool of Jello', 'have a trampoline floor in your house'],
  ['never eat candy again', 'never watch a movie again'],
  ['be the fastest kid at school', 'be the smartest kid at school'],
  ['have a magic carpet', 'have your own submarine'],
  ['sneeze glitter', 'burp bubbles'],
  ['have hands for feet', 'have feet for hands'],
  ['be a wizard', 'be a superhero'],
  ['sleep in every day', 'never need sleep at all'],
  ['eat a live cricket', 'eat a raw onion like an apple'],
  ['always have to sing instead of talk', 'always have to dance everywhere you go'],
  ['own a candy store', 'own a toy store'],
  ['meet your favorite character', 'be in your favorite show'],
  ['have a personal chef', 'have a personal chauffeur'],
  ['play in the NBA', 'play in the World Cup'],
];

// facts come from the public internet — keep them kid-appropriate
const FACT_BLOCKLIST = /\b(sex|drug|kill|murder|die[ds]?|death|alcohol|beer|wine|cigarette|nazi|war crimes?|suicide|gun|weapon)\b/i;

let gameMode = null;
const gameSeen = { fact: new Set(), joke: new Set(), wyr: new Set() };

function pickFresh(pack, kind) {
  const seen = gameSeen[kind];
  if (seen.size >= pack.length) seen.clear();
  let i;
  do { i = Math.floor(Math.random() * pack.length); } while (seen.has(i));
  seen.add(i);
  return pack[i];
}

$('gameModes').querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    gameMode = b.dataset.game;
    $('gameModes').querySelectorAll('button').forEach((x) =>
      x.classList.toggle('on', x === b));
    $('gameCard').classList.remove('hidden');
    nextGame();
  }));

$('gameNext').addEventListener('click', nextGame);

async function nextGame() {
  const content = $('gameContent');
  $('wyrOptions').classList.add('hidden');
  content.classList.remove('hidden');

  if (gameMode === 'wyr') {
    content.innerHTML = 'Would you rather…';
    const [a, bOpt] = pickFresh(WYR_PACK, 'wyr');
    $('wyrA').textContent = a[0].toUpperCase() + a.slice(1);
    $('wyrB').textContent = bOpt[0].toUpperCase() + bOpt.slice(1);
    $('wyrA').classList.remove('picked'); $('wyrB').classList.remove('picked');
    $('wyrOptions').classList.remove('hidden');
    return;
  }

  content.textContent = '🎲 …';
  if (gameMode === 'joke') {
    try {
      const r = await (await fetch('https://icanhazdadjoke.com/', {
        headers: { Accept: 'application/json' } })).json();
      content.innerHTML = `${esc(r.joke)}<small>😂 fresh from the joke machine</small>`;
      return;
    } catch { /* offline → pack */ }
    content.textContent = pickFresh(JOKES_PACK, 'joke');
  } else {
    try {
      const r = await (await fetch('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en')).json();
      const fact = String(r.text ?? '').trim();
      if (fact && fact.length < 300 && !FACT_BLOCKLIST.test(fact)) {
        content.innerHTML = `${esc(fact)}<small>🧠 true story</small>`;
        return;
      }
    } catch { /* offline → pack */ }
    content.textContent = pickFresh(FACTS_PACK, 'fact');
  }
}

for (const id of ['wyrA', 'wyrB']) {
  $(id).addEventListener('click', () => {
    $('wyrA').classList.toggle('picked', id === 'wyrA');
    $('wyrB').classList.toggle('picked', id === 'wyrB');
  });
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
  loadDevices();
  loadEarnings();
  loadCountdowns();
  loadSiriKeys();
  $('memberList').innerHTML = state.members.map((m) => {
    const login = m.email ? esc(m.email)
      : m.authUserId ? `signs in as “${esc(m.displayName.toLowerCase())}”` : 'no login';
    return `<div class="memberRow"><i style="background:${m.color}"></i>${esc(m.displayName)}
      <span class="role">${m.role === 'admin' ? 'parent' : m.role} · ${login}</span></div>`;
  }).join('');
}

async function loadCalendars() {
  const { calendars } = await apiFetch('/calendars');
  const ownerOptions = (sel) => `<option value="">Family</option>` + state.members.map((m) =>
    `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.displayName)}</option>`).join('');
  $('calList').innerHTML = calendars.map((cal) => `
    <div class="memberRow"><i style="background:${cal.color ?? '#666'}"></i>${esc(cal.name)}
      <span class="role">
      ${cal.provider === 'ics'
        ? `<select data-owner="${cal.id}" style="padding:4px 6px;font-size:.78rem;width:auto">${ownerOptions(cal.ownerMemberId)}</select>
           <button data-cal="${cal.id}" style="background:none;color:var(--red);padding:2px 6px">✕</button>`
        : `${cal.provider}${cal.access === 'read_only' ? ' · view-only' : ''}`}</span></div>`).join('');
  $('calList').querySelectorAll('button[data-cal]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remove this calendar and its events from the hub?')) return;
      await apiFetch(`/calendars/${b.dataset.cal}`, { method: 'DELETE' });
      loadCalendars();
    }));
  // reassign owner: events re-shade in that person's color immediately
  $('calList').querySelectorAll('select[data-owner]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      await apiFetch(`/calendars/${sel.dataset.owner}`, {
        method: 'PATCH',
        body: JSON.stringify({ ownerMemberId: sel.value || null }),
      });
      state.weekKey = null; // recolor the day view on next visit
      loadCalendars();
      toast('Calendar owner updated ✓');
    }));
  // owner choices in the add form
  $('acOwner').innerHTML = `<option value="">Whole family</option>` + state.members.map((m) =>
    `<option value="${m.id}">${esc(m.displayName)}</option>`).join('');
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
        memberId: $('acOwner').value || undefined, // color follows the owner
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

async function loadDevices() {
  const { devices } = await apiFetch('/devices');
  const displays = devices.filter((d) => d.isDisplayOnly && !d.revokedAt);
  $('deviceList').innerHTML = displays.map((d) => {
    const seen = d.lastSeenAt
      ? `seen ${new Date(d.lastSeenAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : 'never used';
    return `<div class="memberRow"><i style="background:var(--accent)"></i>${esc(d.name)}
      <span class="role">${d.kind === 'apple_tv' ? 'TV' : 'iPad'} · ${seen}
      <button data-dev="${d.id}" style="background:none;color:var(--red);padding:2px 8px">Revoke</button></span></div>`;
  }).join('') || '<div class="allDone">No displays paired yet.</div>';
  $('deviceList').querySelectorAll('button[data-dev]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Revoke this display? It signs out immediately and must be re-paired.')) return;
      await apiFetch(`/devices/${b.dataset.dev}`, { method: 'DELETE' });
      loadDevices();
      toast('Display revoked ✓');
    }));
}

async function loadSiriKeys() {
  const nameOf = Object.fromEntries(state.members.map((m) => [m.id, m.displayName]));
  const { keys } = await apiFetch('/siri/keys');
  $('siriKeyList').innerHTML = keys.map((k) => {
    const used = k.lastUsedAt
      ? `used ${new Date(k.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : 'never used';
    return `<div class="memberRow">🔑 ${esc(nameOf[k.memberId] ?? '?')}
      <span class="role">${used}
      <button data-sk="${k.id}" style="background:none;color:var(--red);padding:2px 8px">Revoke</button></span></div>`;
  }).join('');
  $('skMember').innerHTML = state.members.filter((m) => m.authUserId || m.email)
    .map((m) => `<option value="${m.id}">${esc(m.displayName)}</option>`).join('');
  $('siriKeyList').querySelectorAll('button[data-sk]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Revoke this Siri key? Their shortcuts stop working immediately.')) return;
      await apiFetch(`/siri/keys/${b.dataset.sk}`, { method: 'DELETE' });
      loadSiriKeys();
    }));
}

$('siriKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { key, memberName } = await apiFetch('/siri/keys', {
      method: 'POST', body: JSON.stringify({ memberId: $('skMember').value }),
    });
    $('siriKeyValue').textContent = key;
    $('siriKeyResult').classList.remove('hidden');
    toast(`Siri key for ${memberName} created ✓`);
    loadSiriKeys();
  } catch (err) { toast(err.message); }
});

$('siriKeyCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('siriKeyValue').textContent).catch(() => {});
  toast('Key copied ✓');
});

$('pairBtn').addEventListener('click', async () => {
  const { code } = await apiFetch('/devices/pairing-code', {
    method: 'POST',
    body: JSON.stringify({ kind: 'apple_tv', name: 'Home display' }),
  });
  $('pairResult').textContent = code;
});

// ----------------------------------------------------------------
// Private vault — the 🇺🇸 button appears only for its owner; every
// request is re-checked server-side, so the button is a door, not
// the lock.
// ----------------------------------------------------------------

const VAULT_OWNER_EMAIL = 'heck7554@gmail.com';

function maybeShowVaultButton() {
  $('vaultBtn').classList.toggle('hidden', state.me?.email !== VAULT_OWNER_EMAIL);
}

$('vaultBtn').addEventListener('click', () => {
  $('vaultView').classList.remove('hidden');
  loadVault();
});
$('vaultClose').addEventListener('click', () => $('vaultView').classList.add('hidden'));

// Docs | Business | Archive segmented control
$('vaultSeg').querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    $('vaultSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    const view = b.dataset.vs;
    $('vaultDocs').classList.toggle('hidden', view !== 'docs');
    $('vaultBiz').classList.toggle('hidden', view !== 'biz');
    $('vaultArc').classList.toggle('hidden', view !== 'arc');
    if (view === 'biz') loadBiz();
    if (view === 'arc') loadArchive();
  }));

// ── Archived chat (owner-only reading room) ─────────────────────

async function loadArchive() {
  const { messages } = await apiFetch('/chat/archive');
  $('arcList').innerHTML = messages.map((m) => `
    <div class="vaultItem">
      <div style="flex:1">
        <div class="byline">${esc(m.senderName ?? '')} · ${new Date(m.createdAt).toLocaleString(undefined,
          { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${m.isAnnouncement ? ' · 📣' : ''}</div>
        <div style="font-size:.92rem">${esc(m.body)}</div>
      </div>
    </div>`).join('') || '<div class="allDone">Nothing archived yet.</div>';
}

// ── Business: market intelligence panel ─────────────────────────

const fmtNum = (n) => Number(n).toLocaleString();

async function loadBiz(refresh = false) {
  try {
    const { data, asOf } = await apiFetch(
      refresh ? '/biz/market/refresh' : '/biz/market',
      refresh ? { method: 'POST' } : {},
    );
    renderBiz(data, asOf);
  } catch (err) { toast(err.message); }
}

$('bizRefresh').addEventListener('click', async () => {
  const b = $('bizRefresh');
  b.disabled = true; b.textContent = 'Pulling live data…';
  await loadBiz(true);
  b.disabled = false; b.textContent = 'Refresh';
});

function renderBiz(d, asOf) {
  $('bizAsOf').textContent = `Data as of ${new Date(asOf).toLocaleDateString()} · NPPES + CMS + Census, public de-identified data`;

  const seniors = Object.values(d.zips ?? {}).reduce((s, z) => s + (z.seniors65plus ?? 0), 0);
  $('bizKpis').innerHTML = [
    [fmtNum(d.county?.popNow ?? 0), 'county population (ACS)'],
    [`+${d.county?.growth2020to2025pct ?? '?'}%`, 'growth 2020–25'],
    [fmtNum(d.providers?.nppesWarrenTotal ?? 0), 'anesthesia providers (NPPES)'],
    [fmtNum(seniors), 'residents 65+'],
  ].map(([v, l]) => `<div class="k"><b>${v}</b><span>${l}</span></div>`).join('');

  const bench = d.benchmarks ?? [];
  const max = Math.max(...bench.map((b) => b.per100k), 1);
  $('bizBench').innerHTML = bench.map((b) => `
    <div class="benchRow ${b.market.startsWith('Bowling Green') ? 'me' : ''}">
      <span class="bn">${esc(b.market.replace(' (Warren Co)', '').replace(' (workforce est.)', ''))}</span>
      <span class="bb"><i style="width:${Math.round(b.per100k / max * 100)}%"></i></span>
      <span class="bv">${b.per100k}</span>
    </div>`).join('');

  $('bizZips').innerHTML = Object.entries(d.zips ?? {})
    .sort((a, b) => b[1].seniors65plus - a[1].seniors65plus)
    .map(([zip, z]) => `
      <div class="zipRow">
        <span class="zc">${zip}</span>
        <span class="zd">${fmtNum(z.population)} pop · ${fmtNum(z.seniors65plus)} 65+</span>
        <span>${z.providers} prov</span>
        <span style="min-width:64px;text-align:right">${z.seniorsPerProvider ? fmtNum(z.seniorsPerProvider) + '/prov' : '—'}</span>
        ${(!z.providers && z.seniors65plus > 250) || (z.seniorsPerProvider ?? 0) > 500
          ? '<span class="gapTag">GAP</span>' : ''}
      </div>`).join('');

  $('bizFindings').innerHTML = (d.findings ?? [])
    .map((f, i) => `<div class="finding"><b class="n">${i + 1}</b><span>${esc(f)}</span></div>`).join('');
}

async function loadVault() {
  const { items } = await apiFetch('/vault');
  $('vaultList').innerHTML = items.map((it) => `
    <div class="vaultItem">
      <span class="vKind">${it.kind === 'file' ? '📄' : '🔗'}</span>
      <span class="vTitle" data-open="${it.id}" data-kind="${it.kind}"
        ${it.kind === 'link' ? `data-url="${esc(it.url)}"` : ''}>${esc(it.title)}</span>
      <button class="vDel" data-del="${it.id}">✕</button>
    </div>`).join('') || '<div class="allDone">Nothing stored yet.</div>';

  $('vaultList').querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (el.dataset.kind === 'link') return window.open(el.dataset.url, '_blank');
      const { path } = await apiFetch(`/vault/file/${el.dataset.open}`);
      window.open(`${CFG.SUPABASE_URL}${path}`, '_blank'); // signed, expires in an hour
    }));
  $('vaultList').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remove this from the vault?')) return;
      await apiFetch(`/vault/${b.dataset.del}`, { method: 'DELETE' });
      loadVault();
    }));
}

$('vaultLinkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await apiFetch('/vault/link', {
      method: 'POST',
      body: JSON.stringify({ title: $('vlTitle').value.trim(), url: $('vlUrl').value.trim() }),
    });
    e.target.reset();
    loadVault();
    toast('Link saved ✓');
  } catch (err) { toast(err.message); }
});

$('vaultUploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('vaultFile').files[0];
  if (!file) return;
  const btn = $('vaultUploadBtn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const form = new FormData();
    form.append('file', file);
    // multipart: browser sets the boundary — no JSON content-type here
    const res = await fetch(`${API}/vault/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access}` },
      body: form,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    e.target.reset();
    loadVault();
    toast('Uploaded ✓');
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = 'Upload'; }
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
