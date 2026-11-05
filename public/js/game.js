import { CONFIG } from './config.js';
import { formatDistance, formatPoints } from './scoring.js';
import { createMap, pinIcon, resetView } from './map.js';
import { panoUrlFor, checkImageHost, switchToProxy, loadPano } from './locations.js';
import { getDaily, sendGuess, getLeaderboard, updateName, savedName, saveName } from './api.js';

const $ = (id) => document.getElementById(id);

const els = {
  btnStart: $('btn-start'),
  startError: $('start-error'),
  playerName: $('player-name'),
  addressName: $('address-name'),
  puzzleNo: $('puzzle-no'),
  playedToday: $('played-today'),
  playedScore: $('played-score'),
  playedRank: $('played-rank'),
  btnLeaderboard: $('btn-leaderboard'),
  hudRound: $('hud-round'),
  hudTimer: $('hud-timer'),
  hudTimerItem: $('hud-timer-item'),
  hudScore: $('hud-score'),
  timerFill: $('timer-fill'),
  guessPanel: $('guess-panel'),
  guessError: $('guess-error'),
  mapCover: $('map-cover'),
  mapCollapse: $('map-collapse'),
  mapBigger: $('map-bigger'),
  mapSmaller: $('map-smaller'),
  mapPin: $('map-pin'),
  btnGuess: $('btn-guess'),
  resultCard: $('result-card'),
  resultPlace: $('result-place'),
  resultPoints: $('result-points'),
  resultBar: $('result-bar'),
  resultDistance: $('result-distance'),
  resultFact: $('result-fact'),
  panoLoading: $('pano-loading'),
  btnNext: $('btn-next'),
  summaryCard: $('summary-card'),
  summaryTotal: $('summary-total'),
  summaryMax: $('summary-max'),
  summaryRows: $('summary-rows'),
  summaryBoard: $('summary-board'),
  summaryRank: $('summary-rank'),
  summaryKicker: $('summary-kicker'),
  summaryVerdict: $('summary-verdict'),
  summaryYear: $('summary-year'),
  btnFullBoard: $('btn-full-board'),
  btnSummaryHome: $('btn-summary-home'),
  boardNumber: $('board-number'),
  boardMeta: $('board-meta'),
  boardList: $('board-list'),
  boardYou: $('board-you'),
  btnBoardBack: $('btn-board-back'),
};

const state = {
  daily: null,        // today's puzzle from the server
  rounds: [],         // [{ id, image, startYaw }]
  results: [],        // [{ loc: {name, lat, lng, funFact}, guess, distance, points, timedOut }]
  index: 0,
  guess: null,        // {lat, lng} or null
  submitted: false,   // guess sent (or being sent) for this round
  submitting: false,
  failed: false,      // last send failed; the button offers a retry
  timedOut: false,
  viewer: null,
  timerId: null,
  deadline: 0,
  roundToken: 0,      // guards against stale async callbacks between rounds
  hostCheck: null,
  boardReturn: 'start',
};

let guessMap = null;
let guessMarker = null;
let resultMap = null;
let resultLayer = null;

// ---------- Screens ----------

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.toggle('active', s.id === `screen-${name}`);
  });
}

const totalScore = () => state.results.reduce((sum, r) => sum + r.points, 0);
const currentName = () => els.playerName.value.trim();

// ---------- Setup ----------

function init() {
  // The leaderboard screen gets its own copy of the waving-bear loader.
  els.boardLoading = els.panoLoading.cloneNode(true);
  els.boardLoading.id = 'board-loading';
  $('screen-leaderboard').appendChild(els.boardLoading);

  $('rule-time').textContent = `${CONFIG.roundTimeSeconds}s`;
  $('rule-points').textContent = formatPoints(CONFIG.scoring.maxPoints);

  els.playerName.value = savedName();
  updateAddress();
  els.playerName.addEventListener('input', () => {
    updateAddress();
    els.startError.hidden = true;
  });
  els.playerName.addEventListener('change', onNameChange);
  els.playerName.addEventListener('keydown', (e) => { if (e.key === 'Enter') onStart(); });

  els.btnStart.addEventListener('click', onStart);
  els.btnLeaderboard.addEventListener('click', () => showLeaderboard('start'));
  els.btnGuess.addEventListener('click', () => submitGuess(state.timedOut));
  els.btnNext.addEventListener('click', nextRound);
  els.btnFullBoard.addEventListener('click', () => showLeaderboard('result'));
  els.btnSummaryHome.addEventListener('click', goHome);
  els.btnBoardBack.addEventListener('click', () => (state.boardReturn === 'result' ? showScreen('result') : goHome()));

  els.mapCover.addEventListener('click', () => setMapExpanded(true));
  els.mapCollapse.addEventListener('click', () => setMapExpanded(false));
  els.mapBigger.addEventListener('click', () => setMapSize(mapPrefs.size + 1));
  els.mapSmaller.addEventListener('click', () => setMapSize(mapPrefs.size - 1));
  els.mapPin.addEventListener('click', () => setMapPinned(!mapPrefs.pinned));
  setMapSize(mapPrefs.size);
  setMapPinned(mapPrefs.pinned);
  els.guessPanel.addEventListener('transitionend', (e) => {
    if (e.target === els.guessPanel) guessMap?.invalidateSize();
  });
  els.guessPanel.addEventListener('mouseenter', () => setTimeout(() => guessMap?.invalidateSize(), 220));
  document.addEventListener('keydown', onKey);

  setInterval(updateCountdowns, 30_000);
  loadDaily();
}

async function loadDaily() {
  els.btnStart.disabled = true;
  els.btnStart.textContent = 'Loading…';
  els.startError.hidden = true;
  try {
    state.daily = await getDaily();
  } catch (err) {
    console.error(err);
    showStartError(err.message);
    els.btnStart.disabled = false;
    els.btnStart.textContent = 'Try again';
    els.btnStart.onclick = () => { els.btnStart.onclick = null; loadDaily(); };
    return;
  }

  const d = state.daily;
  state.rounds = d.rounds.map((r, i) => ({ id: `round-${i}`, image: r.image, startYaw: r.startYaw }));
  state.results = d.results.map(fromServer);
  els.puzzleNo.textContent = `Daily Puzzle No. ${d.number} · ${formatDate(d.date)}`;
  $('rule-rounds').textContent = state.rounds.length;
  updateCountdowns();

  if (state.rounds.length === 0) {
    showStartError('No puzzle today. Check back soon!');
    els.btnStart.textContent = 'No puzzle today';
    return;
  }

  // In the background while the start page shows: check the photo host and
  // start downloading the first unplayed photo.
  state.hostCheck = checkImageHost(state.rounds);
  if (!d.finished) prefetch(state.rounds[state.results.length]);
  renderStart();
}

const fromServer = (r) => ({
  loc: r.answer, guess: r.guess, distance: r.distance, points: r.points, timedOut: r.timedOut,
});

function renderStart() {
  const d = state.daily;
  if (!d) return;
  els.btnStart.disabled = false;
  els.playedToday.hidden = !d.finished;
  if (d.finished) {
    els.playedScore.textContent = formatPoints(totalScore());
    els.playedRank.textContent = '';
    getLeaderboard(1).then((b) => {
      if (b.you) els.playedRank.textContent = ` · #${b.you.rank} of ${b.players}`;
    }).catch(() => {});
    els.btnStart.textContent = 'See your results';
  } else if (state.results.length > 0) {
    els.btnStart.textContent = `Continue (round ${state.results.length + 1} of ${state.rounds.length})`;
  } else {
    els.btnStart.textContent = "Play today's puzzle";
  }
}

function showStartError(message) {
  els.startError.textContent = message;
  els.startError.hidden = false;
}

function updateAddress() {
  els.addressName.textContent = currentName() || 'A Curious Wanderer';
}

function onNameChange() {
  const name = currentName();
  if (!name) return;
  saveName(name);
  // Already on today's leaderboard? Update the name shown there.
  if (state.daily?.finished) updateName(name).catch(() => {});
}

function onStart() {
  if (!state.daily || els.btnStart.disabled) return;
  if (state.daily.finished) return showSummary();
  const name = currentName();
  if (!name) {
    showStartError('Write your name on the postcard first. It goes on the leaderboard!');
    els.playerName.focus();
    return;
  }
  saveName(name);
  state.index = state.results.length;
  startRound();
}

function goHome() {
  showScreen('start');
  renderStart();
}

function onKey(e) {
  if (e.key !== 'Enter') return;
  const active = document.querySelector('.screen.active')?.id;
  if (active === 'screen-round' && ((state.guess && !state.submitted) || state.failed)) submitGuess(state.timedOut);
  else if (active === 'screen-result' && !els.resultCard.hidden) nextRound();
}

// ---------- Countdown to the next puzzle ----------

function updateCountdowns() {
  if (!state.daily) return;
  const ms = state.daily.nextPuzzleAt - Date.now();
  if (ms <= 0) {
    // A new day: refresh the start page (games in progress can still finish).
    if (document.querySelector('.screen.active')?.id === 'screen-start') location.reload();
    return;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const text = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : 'less than a minute';
  document.querySelectorAll('.next-in-value').forEach((el) => { el.textContent = text; });
}

function formatDate(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// ---------- Preloading ----------

async function prefetch(round) {
  if (!round) return;
  await state.hostCheck;
  const url = await panoUrlFor(round, state.rounds.indexOf(round));
  loadPano(url).catch(() => {}); // failures are handled when the round starts
}

// ---------- Rounds ----------

async function startRound() {
  const token = ++state.roundToken;
  const round = state.rounds[state.index];
  Object.assign(state, { guess: null, submitted: false, submitting: false, failed: false, timedOut: false });

  showScreen('round');
  els.hudRound.textContent = `${state.index + 1} / ${state.rounds.length}`;
  els.hudScore.textContent = formatPoints(totalScore());
  els.guessError.hidden = true;
  renderTimer(CONFIG.roundTimeSeconds * 1000);
  setGuessButton();
  setMapExpanded(false);

  // Guess map (created once, reused every round)
  if (!guessMap) {
    guessMap = createMap('guess-map', { doubleClickZoom: false });
    guessMap.on('click', (e) => placeGuess(e.latlng));
  }
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  guessMap.invalidateSize();
  resetView(guessMap);

  // Panorama
  if (state.viewer) { state.viewer.destroy(); state.viewer = null; }
  showLoader();
  await state.hostCheck;
  if (token !== state.roundToken) return;
  showPano(round, token, Math.random() * 360 - 180, false);
}

async function showPano(round, token, randomYaw, isRetry) {
  const url = await panoUrlFor(round, state.index);
  if (token !== state.roundToken) return;

  // Usually already downloaded by prefetch(); otherwise wait for it here.
  // The loader stays up until the viewer reports the photo is on screen.
  let src;
  try {
    src = await loadPano(url);
  } catch {
    if (token !== state.roundToken) return;
    // Photo host blocked or down: switch to our proxy and try again.
    if (!isRetry && switchToProxy()) return showPano(round, token, randomYaw, true);
    src = url; // let the viewer show its error message
  }
  if (token !== state.roundToken) return;
  if (state.viewer) { state.viewer.destroy(); state.viewer = null; }

  const viewer = pannellum.viewer('pano', {
    type: 'equirectangular',
    panorama: src,
    autoLoad: true,
    yaw: round.startYaw ?? randomYaw,
    hfov: 100,
    minHfov: 40,
    maxHfov: 120,
    showFullscreenCtrl: false,
    compass: false,
  });
  state.viewer = viewer;

  // Clock starts once the photo is visible, so slow downloads don't eat time.
  const begin = () => { if (token === state.roundToken && !state.timerId && !state.submitted) startTimer(); };
  viewer.on('load', () => {
    if (token === state.roundToken) hideLoader();
    begin();
    // While this round is played, download the next round's photo.
    prefetch(state.rounds[state.index + 1]);
  });
  viewer.on('error', () => {
    // Photo host blocked or down: retry this photo (and all later ones) via our proxy.
    if (!isRetry && token === state.roundToken && switchToProxy()) {
      setTimeout(() => showPano(round, token, randomYaw, true), 0);
    } else {
      if (token === state.roundToken) hideLoader();
      begin();
    }
  });
}

// ---------- Loading screen ----------

const LOADING_LINES = [
  'Climbing Libe Slope…',
  'Waiting for the TCAT…',
  'Crossing the gorge bridge…',
  'Listening for the chimes…',
  'Grabbing a Dairy Bar cone…',
  'Cutting across the Arts Quad…',
  'Bundling up for Ithaca weather…',
  'Finding a seat in Libe Café…',
];
const BOARD_LOADING_LINES = [
  'Tallying the scores…',
  'Sorting the postcards…',
  'Checking the mailbag…',
  'Asking McGraw Tower…',
  'Licking the stamps…',
];
const loaderTimers = new Map();

function showLoader(el = els.panoLoading, lines = LOADING_LINES) {
  const line = el.querySelector('.loader-line');
  let i = Math.floor(Math.random() * lines.length);
  line.textContent = lines[i];
  clearInterval(loaderTimers.get(el));
  loaderTimers.set(el, setInterval(() => {
    i = (i + 1) % lines.length;
    line.textContent = lines[i];
  }, 2200));
  el.hidden = false;
}

function hideLoader(el = els.panoLoading) {
  clearInterval(loaderTimers.get(el));
  loaderTimers.delete(el);
  el.hidden = true;
}

// ---------- Guess map ----------

function placeGuess(latlng) {
  if (state.submitted) return;
  state.guess = { lat: latlng.lat, lng: latlng.lng };
  if (guessMarker) guessMarker.setLatLng(latlng);
  else guessMarker = L.marker(latlng, { icon: pinIcon('guess'), interactive: false }).addTo(guessMap);
  setGuessButton();
}

function setGuessButton() {
  if (state.submitting) {
    els.btnGuess.disabled = true;
    els.btnGuess.textContent = 'Checking…';
  } else if (state.failed) {
    els.btnGuess.disabled = false;
    els.btnGuess.textContent = 'Try sending again';
  } else {
    els.btnGuess.disabled = !state.guess;
    els.btnGuess.textContent = state.guess ? 'Guess' : 'Place a pin on the map';
  }
}

function setMapExpanded(on) {
  els.guessPanel.classList.toggle('expanded', on);
}

// ---------- Map size & pin (remembered per browser) ----------

// Open sizes (the small corner map is the third, closed state).
const MAP_SIZES = 2; // size-0, size-1: see .guess-panel.size-N in style.css
const PREFS_KEY = 'guesscornell.map';
const mapPrefs = loadMapPrefs();

function loadMapPrefs() {
  const prefs = { size: 0, pinned: false };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {});
  } catch { /* storage unavailable: use defaults */ }
  return prefs;
}

function saveMapPrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(mapPrefs)); } catch { /* ignore */ }
}

function setMapSize(size) {
  mapPrefs.size = Math.max(0, Math.min(MAP_SIZES - 1, size));
  for (let i = 0; i < MAP_SIZES; i++) els.guessPanel.classList.toggle(`size-${i}`, i === mapPrefs.size);
  els.mapBigger.disabled = mapPrefs.size === MAP_SIZES - 1;
  els.mapSmaller.disabled = mapPrefs.size === 0;
  saveMapPrefs();
}

function setMapPinned(on) {
  mapPrefs.pinned = on;
  els.guessPanel.classList.toggle('pinned', on);
  els.mapPin.setAttribute('aria-pressed', String(on));
  els.mapPin.title = on ? 'Let map shrink' : 'Keep map open';
  saveMapPrefs();
}

// ---------- Timer ----------

function startTimer() {
  state.deadline = performance.now() + CONFIG.roundTimeSeconds * 1000;
  state.timerId = setInterval(tick, 100);
  tick();
}

function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
}

function tick() {
  const left = Math.max(0, state.deadline - performance.now());
  renderTimer(left);
  if (left <= 0) submitGuess(true);
}

function renderTimer(msLeft) {
  const secs = Math.ceil(msLeft / 1000);
  els.hudTimer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  els.timerFill.style.transform = `scaleX(${msLeft / (CONFIG.roundTimeSeconds * 1000)})`;
  els.hudTimerItem.classList.toggle('warning', secs <= 10);
}

// ---------- Guessing (scored by the server) ----------

async function submitGuess(timedOut) {
  if (state.submitting || (state.submitted && !state.failed)) return;
  // If time runs out with a pin on the map, that pin counts as the guess.
  state.timedOut = state.timedOut || timedOut;
  Object.assign(state, { submitted: true, submitting: true, failed: false });
  stopTimer();
  els.guessError.hidden = true;
  setGuessButton();

  const token = state.roundToken;
  try {
    const res = await sendGuess({
      name: currentName(),
      date: state.daily.date,
      round: state.index,
      guess: state.guess,
      timedOut: state.timedOut,
    });
    if (token !== state.roundToken) return;
    state.results[state.index] = fromServer(res.result);
    state.daily.finished = res.finished;
    state.submitting = false;
    showResult();
  } catch (err) {
    if (token !== state.roundToken) return;
    Object.assign(state, { submitting: false, failed: true });
    els.guessError.textContent = err.message;
    els.guessError.hidden = false;
    setGuessButton();
  }
}

// ---------- Results ----------

function ensureResultMap() {
  if (!resultMap) {
    resultMap = createMap('result-map');
    resultLayer = L.layerGroup().addTo(resultMap);
  }
  resultMap.invalidateSize();
  resultLayer.clearLayers();
}

function drawPair(r, label = '') {
  const actual = [r.loc.lat, r.loc.lng];
  L.marker(actual, { icon: pinIcon('actual', label), title: r.loc.name || '' }).addTo(resultLayer);
  if (!r.guess) return [actual];
  const guess = [r.guess.lat, r.guess.lng];
  L.polyline([guess, actual], { color: '#1d1d1f', weight: 3, dashArray: '6 8', opacity: 0.8 }).addTo(resultLayer);
  L.marker(guess, { icon: pinIcon('guess', label), interactive: false }).addTo(resultLayer);
  return [actual, guess];
}

function fitTo(points) {
  if (points.length === 1) resultMap.setView(points[0], 17, { animate: false });
  else resultMap.fitBounds(points, { padding: [60, 60], maxZoom: 18, animate: false });
}

function showResult() {
  const r = state.results[state.index];
  showScreen('result');
  els.resultCard.hidden = false;
  els.summaryCard.hidden = true;

  ensureResultMap();
  fitTo(drawPair(r));

  els.resultPlace.textContent = r.loc.name || 'Mystery spot';
  els.resultDistance.textContent = r.guess
    ? `Your guess was ${formatDistance(r.distance)} away${r.timedOut ? ' (time ran out)' : ''}.`
    : "Time's up. No guess was placed.";
  els.resultFact.hidden = !r.loc.funFact;
  els.resultFact.textContent = r.loc.funFact || '';
  els.resultBar.style.width = `${(r.points / CONFIG.scoring.maxPoints) * 100}%`;
  countUp(els.resultPoints, r.points);

  const last = state.index >= state.rounds.length - 1;
  els.btnNext.textContent = last ? 'See final score' : 'Next round';
  els.btnNext.focus({ preventScroll: true });
}

function nextRound() {
  if (state.index >= state.rounds.length - 1) return showSummary();
  state.index++;
  startRound();
}

function showSummary() {
  showScreen('result');
  els.resultCard.hidden = true;
  els.summaryCard.hidden = false;

  ensureResultMap();
  fitTo(state.results.flatMap((r, i) => drawPair(r, String(i + 1))));

  const max = state.rounds.length * CONFIG.scoring.maxPoints;
  els.summaryMax.textContent = formatPoints(max);
  els.summaryKicker.textContent = state.daily ? `✦ Daily Puzzle No. ${state.daily.number} ✦` : '✦ Daily Puzzle ✦';
  // Postmark: today's date, like a real cancellation stamp.
  const when = state.daily ? new Date(`${state.daily.date}T12:00:00Z`) : new Date();
  els.summaryVerdict.textContent = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase();
  els.summaryYear.textContent = String(when.getUTCFullYear());
  countUp(els.summaryTotal, totalScore());
  els.summaryRows.innerHTML = '';
  state.results.forEach((r, i) => {
    const tr = document.createElement('tr');
    for (const text of [
      i + 1,
      r.loc.name || 'Mystery spot',
      r.guess ? formatDistance(r.distance) : '—',
      formatPoints(r.points),
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    els.summaryRows.appendChild(tr);
  });

  // Mini leaderboard: top 5, plus your own row if you're further down.
  els.summaryRank.textContent = '';
  renderBoardMessage(els.summaryBoard, 'Loading leaderboard…');
  getLeaderboard(5)
    .then((b) => {
      renderBoard(els.summaryBoard, b, { appendYou: true });
      if (b.you) els.summaryRank.textContent = `You're #${b.you.rank} of ${b.players} today.`;
    })
    .catch(() => renderBoardMessage(els.summaryBoard, "Couldn't load the leaderboard."));
}

// ---------- Leaderboard ----------

async function showLeaderboard(from) {
  state.boardReturn = from;
  showScreen('leaderboard');
  els.boardNumber.textContent = state.daily ? `No. ${state.daily.number}` : '';
  els.boardMeta.textContent = '';
  els.boardYou.hidden = true;
  const token = (state.boardToken = (state.boardToken || 0) + 1);
  const card = els.boardLoading.parentElement.querySelector('.board-card');
  card.hidden = true;
  showLoader(els.boardLoading, BOARD_LOADING_LINES);
  const done = () => {
    hideLoader(els.boardLoading);
    card.hidden = false;
  };
  try {
    const b = await getLeaderboard(50);
    if (token !== state.boardToken) return;
    done();
    els.boardMeta.textContent = `${formatDate(b.date)} · ${b.players} ${b.players === 1 ? 'player' : 'players'}`;
    renderBoard(els.boardList, b);
    if (b.you && !b.top.some((t) => t.you)) {
      els.boardYou.textContent = `You: #${b.you.rank} with ${formatPoints(b.you.score)} pts`;
      els.boardYou.hidden = false;
    } else if (!b.you) {
      els.boardYou.textContent = state.daily?.finished ? '' : "Finish today's puzzle to get on the board!";
      els.boardYou.hidden = !els.boardYou.textContent;
    }
  } catch (err) {
    if (token !== state.boardToken) return;
    done();
    renderBoardMessage(els.boardList, err.message);
  }
}

function renderBoardMessage(list, message) {
  list.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'board-empty';
  li.textContent = message;
  list.appendChild(li);
}

function renderBoard(list, board, { appendYou = false } = {}) {
  const rows = [...board.top];
  if (appendYou && board.you && !rows.some((r) => r.you)) {
    rows.push({ gap: true }, { ...board.you, you: true });
  }
  if (rows.length === 0) return renderBoardMessage(list, 'No scores yet. Be the first!');
  list.innerHTML = '';
  for (const row of rows) {
    const li = document.createElement('li');
    if (row.gap) {
      li.className = 'board-gap';
      li.textContent = '⋯';
    } else {
      li.className = row.you ? 'you' : '';
      for (const [cls, text] of [['rank', `#${row.rank}`], ['name', row.name], ['score', formatPoints(row.score)]]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text; // names are user-written: never use innerHTML
        li.appendChild(span);
      }
    }
    list.appendChild(li);
  }
}

function countUp(el, target, ms = 700) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = formatPoints(Math.round(target * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

init();
