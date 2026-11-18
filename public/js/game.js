import { CONFIG } from './config.js';
import { formatDistance, formatPoints } from './scoring.js';
import { createMap, pinIcon, resetView } from './map.js';
import { panoUrlFor, checkImageHost, switchToProxy, loadPano } from './locations.js';
import { getDaily, sendGuess, getLeaderboard, updateName, savedName, saveName } from './api.js';

const $ = (id) => document.getElementById(id);

const els = {
  btnStart: $('btn-start'),
  btnPromo: $('btn-promo'),
  promoRibbon: $('promo-ribbon'),
  summaryPromo: $('summary-promo'),
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
  lookHint: $('look-hint'),
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

/** Send a game event to Google Analytics (skipped if it's blocked). */
function track(event, params = {}) {
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', event, { puzzle_number: state.daily?.number, ...params });
    }
  } catch { /* analytics must never break the game */ }
}

const totalScore = () => state.results.reduce((sum, r) => sum + r.points, 0);
const currentName = () => els.playerName.value.trim();

// ---------- Setup ----------

function init() {
  // Any drag on the photo means they've found out it moves.
  $('pano').addEventListener('pointerdown', () => { hasLooked = true; hideLookHint(); }, true);

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

  const closePromo = () => { const then = promoThen; promoThen = null; then?.(); };
  els.btnPromo.addEventListener('click', closePromo);
  els.promoRibbon.addEventListener('click', () => showPromo(state.promo.stage, goHome, 'Continue'));
  els.summaryPromo.addEventListener('click', () => showPromo('result', showSummary, 'See your score'));

  setInterval(updateCountdowns, 30_000);
  const preview = new URLSearchParams(location.search).get('promoPreview');
  if (preview) previewPromo(preview);
  else loadDaily();
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
  state.rounds = d.rounds.map((r, i) => ({ id: `round-${i}`, image: r.image, startYaw: r.startYaw, startYawRange: r.startYawRange }));
  state.results = d.results.map(fromServer);
  state.promo = d.promo;
  state.promoResult = d.promoResult;
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
  // A giveaway announced or running: show it first, then the usual home screen.
  // (Not on giveaway day for players who've already finished: they have their result.)
  if (state.promo && !(state.promo.stage === 'live' && d.finished)) showPromo(state.promo.stage, goHome, 'Continue');
}

const fromServer = (r) => ({
  loc: r.answer, guess: r.guess, distance: r.distance, points: r.points, timedOut: r.timedOut,
});

function renderStart() {
  const d = state.daily;
  if (!d) return;
  els.btnStart.disabled = false;
  els.playedToday.hidden = !d.finished;
  els.promoRibbon.hidden = !state.promo;
  if (state.promo) {
    els.promoRibbon.innerHTML = state.promo.stage === 'live'
      ? '&#129391; <strong>Giveaway today!</strong> Finish the puzzle to see if you won. Details &rarr;'
      : '&#129391; <strong>Giveaway tomorrow!</strong> 5 players win a Collegetown Bagels gift card. Details &rarr;';
  }
  if (d.finished) {
    els.playedScore.textContent = formatPoints(totalScore());
    els.playedRank.textContent = '';
    getLeaderboard(1).then((b) => {
      if (b.you) els.playedRank.textContent = ` · #${b.you.rank}`;
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

const NAME_REJECTED = 422; // the server's profanity check said no

function onNameChange() {
  const name = currentName();
  if (!name) return;
  saveName(name);
  // Already on today's leaderboard? Update the name shown there.
  if (state.daily?.finished) {
    updateName(name).catch((err) => {
      if (err.status === NAME_REJECTED) showStartError(err.message);
    });
  }
}

let checkingName = false;

async function onStart() {
  if (!state.daily || els.btnStart.disabled || checkingName) return;
  if (state.daily.finished) return showSummary();
  const name = currentName();
  if (!name) {
    showStartError('Write your name on the postcard first. It goes on the leaderboard!');
    els.playerName.focus();
    return;
  }
  // Check the name before playing. Only a clear "not allowed" stops the game;
  // if the check can't be reached, play on (the server checks again at the end).
  checkingName = true;
  try {
    await updateName(name);
  } catch (err) {
    if (err.status === NAME_REJECTED) {
      showStartError(err.message);
      els.playerName.focus();
      els.playerName.select();
      return;
    }
  } finally {
    checkingName = false;
  }
  saveName(name);
  state.index = state.results.length;
  track(state.index === 0 ? 'puzzle_start' : 'puzzle_resume', { round: state.index + 1 });
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
  clearTimeout(lookHintTimer);
  els.lookHint.hidden = true;
  showLoader();
  await state.hostCheck;
  if (token !== state.roundToken) return;
  showPano(round, token, startDirection(round), false);
}

/** A random direction to start facing, within the photo's allowed range if it has one. */
function startDirection(round) {
  const [from, to] = round.startYawRange || [-180, 180];
  const yaw = from + Math.random() * (to - from);
  return ((yaw + 540) % 360) - 180; // keep within -180..180
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
    if (token === state.roundToken) {
      hideLoader();
      showLookHint();
    }
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

// "Drag to look around": shown on the first round, and on later rounds until
// the player has actually moved the view once.
let lookHintTimer = null;
let hasLooked = false;

function showLookHint() {
  if (hasLooked && state.index > 0) return;
  const touch = window.matchMedia('(hover: none)').matches;
  els.lookHint.querySelector('.look-text').textContent = touch ? 'Swipe to look around' : 'Drag to look around';
  els.lookHint.classList.remove('fading');
  els.lookHint.hidden = false;
  clearTimeout(lookHintTimer);
  lookHintTimer = setTimeout(hideLookHint, 5000);
}

function hideLookHint() {
  clearTimeout(lookHintTimer);
  if (els.lookHint.hidden) return;
  els.lookHint.classList.add('fading');
  lookHintTimer = setTimeout(() => { els.lookHint.hidden = true; }, 400);
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
  hideLookHint();
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
    if (res.promo) state.promoResult = res.promo;
    state.submitting = false;
    const r = state.results[state.index];
    track('round_complete', {
      round: state.index + 1, points: r.points, distance_m: Math.round(r.distance ?? 0), timed_out: !!r.timedOut,
    });
    if (res.finished) track('puzzle_complete', { score: totalScore() });
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
  if (state.index >= state.rounds.length - 1) {
    if (state.promoResult) return showPromo('result', showSummary, 'See your score');
    return showSummary();
  }
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
  const pr = state.promoResult;
  els.summaryPromo.hidden = !pr;
  if (pr) {
    els.summaryPromo.innerHTML = pr.won
      ? `&#129391; <strong>You won a ${esc(pr.prize)}!</strong> Claim code <strong>${esc(pr.code)}</strong>. Tap for details.`
      : `&#129391; Giveaway: you were player <strong>#${pr.n}</strong> to finish. ${pr.nearest < pr.n ? 'Last' : 'First'} winning number: #${pr.nearest}.`;
  }
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
      if (b.you) els.summaryRank.textContent = `You're #${b.you.rank} today.`;
    })
    .catch(() => renderBoardMessage(els.summaryBoard, "Couldn't load the leaderboard."));
}

// ---------- Giveaway ----------

let promoThen = null;

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const longDate = (date) => new Date(`${date}T12:00:00Z`)
  .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
const words = (n) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
const capital = (t) => t[0].toUpperCase() + t.slice(1);

// A row of tiny students for the 1868 class photo (some in top hats).
// One row of two-seat exam tables, students facing us with their papers out.
function examRow(y, tables, x0, step, s, row) {
  const hair = ['#3b2a1e', '#6e4a2e', '#c9a46a', '#4a3426', '#8a5a3a', '#2a1e16'];
  const shirt = ['#b31b1b', '#3f6e8c', '#5d8a4a', '#8c6a3e', '#6b4e7a', '#c47a3a'];
  let out = `<g class="art-row r${row}">`;
  for (let t = 0; t < tables; t++) {
    const cx = x0 + t * step;
    for (const [k, dx] of [[0, -10], [1, 10]]) {
      const x = cx + dx * s, i = t * 2 + k + row * 3;
      out += `<path d="M${x - 8 * s} ${y} Q${x - 8 * s} ${y - 9 * s} ${x} ${y - 9 * s} Q${x + 8 * s} ${y - 9 * s} ${x + 8 * s} ${y} Z" fill="${shirt[i % shirt.length]}"/>`
        + `<circle cx="${x}" cy="${y - 14 * s}" r="${5.2 * s}" fill="#e9d2ad"/>`
        + `<path d="M${x - 5.4 * s} ${y - 14 * s} Q${x} ${y - 22 * s} ${x + 5.4 * s} ${y - 14 * s} Z" fill="${hair[i % hair.length]}"/>`;
    }
    out += `<rect x="${cx - 22 * s}" y="${y - 2 * s}" width="${44 * s}" height="${7 * s}" rx="${1.5 * s}" fill="#a87a4e"/>`
      + `<rect x="${cx - 17 * s}" y="${y - 3.5 * s}" width="${11 * s}" height="${3 * s}" fill="#fffaf0"/>`
      + `<rect x="${cx + 6 * s}" y="${y - 3.5 * s}" width="${11 * s}" height="${3 * s}" fill="#fffaf0"/>`
      + `<line x1="${cx - 22 * s}" y1="${y + 5 * s}" x2="${cx - 20 * s}" y2="${y + 13 * s}" stroke="#6e4a2e" stroke-width="${1.6 * s}"/>`
      + `<line x1="${cx + 22 * s}" y1="${y + 5 * s}" x2="${cx + 20 * s}" y2="${y + 13 * s}" stroke="#6e4a2e" stroke-width="${1.6 * s}"/>`;
  }
  return `${out}</g>`;
}

function classRow(y, count, x0, step, row) {
  const tones = ['#5a4030', '#6e4a2e', '#4a3426', '#7a5a3e'];
  let out = `<g class="art-row r${row}">`;
  for (let i = 0; i < count; i++) {
    const x = x0 + i * step;
    const tone = tones[(i + row) % tones.length];
    out += `<path d="M${x - 7} ${y + 15} Q${x - 7} ${y + 5} ${x} ${y + 5} Q${x + 7} ${y + 5} ${x + 7} ${y + 15} Z" fill="${tone}"/>`
      + `<circle cx="${x}" cy="${y}" r="4.6" fill="#e9d2ad"/>`;
    if ((i * 7 + row * 3) % 4 === 0) out += `<rect x="${x - 3.5}" y="${y - 12}" width="7" height="8" fill="#3b2a1e"/><rect x="${x - 5.5}" y="${y - 5}" width="11" height="1.8" fill="#3b2a1e"/>`;
    else out += `<path d="M${x - 4.6} ${y - 1} Q${x} ${y - 7} ${x + 4.6} ${y - 1} Z" fill="${tone}"/>`;
  }
  return `${out}</g>`;
}

// Special pictures for some winning numbers (chosen in api/_lib/promo.js).
const PROMO_ART = {
  // Barton Hall set up for an exam: rows of two-seat tables under the arched roof, a ticking clock.
  exam: (n) => `
    <div class="promo-art exam" role="img" aria-label="Barton Hall set up for an exam, with ${n} students at tables for two">
      <svg viewBox="0 -10 250 215">
        <defs><clipPath id="exam-clip"><rect x="8" y="16" width="234" height="176" rx="10"/></clipPath></defs>
        <ellipse cx="125" cy="199" rx="105" ry="5" fill="#4a3426" opacity=".16"/>
        <g clip-path="url(#exam-clip)">
          <rect x="8" y="16" width="234" height="176" fill="#efe3c8"/>
          <!-- arched roof trusses -->
          <g fill="none" stroke="#8c6a4e" stroke-width="5">
            <path d="M8 96 Q125 -10 242 96"/>
          </g>
          <g fill="none" stroke="#a88a6a" stroke-width="2">
            <path d="M8 104 Q125 12 242 104"/>
            <line x1="62" y1="40" x2="70" y2="60"/><line x1="96" y1="26" x2="99" y2="48"/><line x1="125" y1="22" x2="125" y2="44"/><line x1="154" y1="26" x2="151" y2="48"/><line x1="188" y1="40" x2="180" y2="60"/>
          </g>
          <!-- high windows -->
          <g fill="#cfe0ea" stroke="#8c6a4e" stroke-width="1.5">
            <rect x="20" y="80" width="14" height="22" rx="7"/><rect x="216" y="80" width="14" height="22" rx="7"/>
          </g>
          <!-- floor -->
          <path d="M8 112 L242 112 L242 192 L8 192 Z" fill="#d9c09a"/>
          <g stroke="#c9ad84" stroke-width="1"><line x1="8" y1="128" x2="242" y2="128"/><line x1="8" y1="150" x2="242" y2="150"/><line x1="8" y1="176" x2="242" y2="176"/></g>
          ${examRow(122, 5, 41, 42, 0.74, 1)}
          ${examRow(153, 4, 42, 55, 0.95, 2)}
          ${examRow(188, 3, 50, 75, 1.2, 3)}
        </g>
        <rect x="8" y="16" width="234" height="176" rx="10" fill="none" stroke="#8c6a4e" stroke-width="3"/>
        <!-- clock -->
        <circle cx="125" cy="72" r="15" fill="#fffaf0" stroke="#3b2a1e" stroke-width="2.5"/>
        <g stroke="#3b2a1e" stroke-width="1.6"><line x1="125" y1="60" x2="125" y2="63"/><line x1="137" y1="72" x2="134" y2="72"/><line x1="125" y1="84" x2="125" y2="81"/><line x1="113" y1="72" x2="116" y2="72"/></g>
        <line x1="125" y1="72" x2="131" y2="76" stroke="#3b2a1e" stroke-width="2.4" stroke-linecap="round"/>
        <line class="art-tick" x1="125" y1="72" x2="125" y2="61" stroke="#b31b1b" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="125" cy="72" r="1.8" fill="#3b2a1e"/>
        <!-- banner -->
        <g transform="rotate(-4 125 14)">
          <path d="M66 4 L56 14 L66 24 Z M184 4 L194 14 L184 24 Z" fill="#8c1515"/>
          <rect x="66" y="-1" width="118" height="30" rx="3" fill="#fffaf0" stroke="#b31b1b" stroke-width="2.5"/>
          <text x="125" y="20" text-anchor="middle" font-family="Abril Fatface, Georgia, serif" font-size="16" fill="#b31b1b">${n} STUDENTS</text>
        </g>
      </svg>
    </div>`,
  // A cartoon dragon in a party hat under a "125 years" banner (Dragon Day).
  dragon: (n) => `
    <div class="promo-art dragon" role="img" aria-label="A cartoon dragon in a party hat under a banner saying ${n} years">
      <svg viewBox="0 0 250 200">
        <ellipse cx="125" cy="192" rx="100" ry="6" fill="#4a3426" opacity=".18"/>
        <!-- banner -->
        <g transform="rotate(-5 66 36)">
          <path d="M14 30 L4 40 L14 50 Z M118 30 L128 40 L118 50 Z" fill="#8c1515"/>
          <rect x="14" y="24" width="104" height="30" rx="3" fill="#fffaf0" stroke="#b31b1b" stroke-width="2.5"/>
          <text x="66" y="45" text-anchor="middle" font-family="Abril Fatface, Georgia, serif" font-size="17" fill="#b31b1b">${n} YEARS</text>
        </g>
        <!-- tail -->
        <path d="M78 156 Q36 168 38 136 Q40 118 56 122" fill="none" stroke="#5d8a4a" stroke-width="14" stroke-linecap="round"/>
        <polygon points="48,118 64,108 62,126" fill="#b31b1b"/>
        <!-- wing (flaps) -->
        <path class="art-wing" d="M112 120 Q92 74 128 66 Q122 88 146 100 Z" fill="#7aa364" stroke="#3f5e30" stroke-width="2" stroke-linejoin="round"/>
        <!-- body -->
        <ellipse cx="122" cy="150" rx="54" ry="34" fill="#5d8a4a"/>
        <ellipse cx="130" cy="160" rx="34" ry="20" fill="#e9d9a6"/>
        <g stroke="#cdb987" stroke-width="2"><line x1="108" y1="152" x2="152" y2="152"/><line x1="104" y1="162" x2="156" y2="162"/><line x1="110" y1="172" x2="150" y2="172"/></g>
        <g fill="#b31b1b"><polygon points="80,128 86,112 94,126"/><polygon points="96,120 104,104 110,119"/><polygon points="114,117 122,102 128,117"/></g>
        <!-- legs -->
        <ellipse cx="98" cy="182" rx="13" ry="8" fill="#4f7a3e"/>
        <ellipse cx="148" cy="182" rx="13" ry="8" fill="#4f7a3e"/>
        <g fill="#fffaf0"><circle cx="90" cy="186" r="2"/><circle cx="97" cy="188" r="2"/><circle cx="104" cy="186" r="2"/><circle cx="140" cy="186" r="2"/><circle cx="147" cy="188" r="2"/><circle cx="154" cy="186" r="2"/></g>
        <!-- neck and head -->
        <path d="M150 136 Q170 116 174 98" fill="none" stroke="#5d8a4a" stroke-width="28" stroke-linecap="round"/>
        <ellipse cx="182" cy="84" rx="27" ry="23" fill="#5d8a4a"/>
        <ellipse cx="203" cy="93" rx="17" ry="12" fill="#6f9c5a"/>
        <circle cx="210" cy="89" r="1.8" fill="#3f5e30"/><circle cx="215" cy="93" r="1.8" fill="#3f5e30"/>
        <circle cx="180" cy="76" r="7.5" fill="#fffaf0"/><circle cx="182.5" cy="76" r="3.8" fill="#3b2a1e"/><circle cx="184" cy="74.5" r="1.2" fill="#fff"/>
        <path d="M190 100 Q199 106 210 101" fill="none" stroke="#3f5e30" stroke-width="2" stroke-linecap="round"/>
        <circle cx="170" cy="92" r="5" fill="#e88a7a" opacity=".45"/>
        <polygon points="162,68 160,54 170,64" fill="#e9d9a6"/>
        <!-- party hat -->
        <g class="art-hat">
          <polygon points="172,64 196,60 187,28" fill="#b31b1b"/>
          <path d="M176 54 L192 51 M180 44 L190 42" stroke="#fffaf0" stroke-width="3"/>
          <circle cx="187" cy="27" r="4.5" fill="#f2d39b"/>
        </g>
        <!-- flame puff -->
        <g class="art-flame">
          <path d="M220 94 Q232 84 244 90 Q236 94 246 100 Q232 104 220 98 Z" fill="#f6b26b"/>
          <path d="M221 95 Q229 90 236 93 Q231 96 237 99 Q229 101 221 97 Z" fill="#f2d39b"/>
        </g>
      </svg>
    </div>`,
  // The Fall Creek gorge suspension bridge with a measuring arrow and a little bear crossing.
  bridge: (n) => {
    const hangers = [84, 96, 108, 120, 132, 144, 156, 168]
      .map((x) => { const t = (x - 70) / 110; const cable = 70 + 88 * t * (1 - t); const deck = 86 + 40 * t * (1 - t); return `<line x1="${x}" y1="${cable.toFixed(1)}" x2="${x}" y2="${deck.toFixed(1)}"/>`; })
      .join('');
    return `
    <div class="promo-art bridge" role="img" aria-label="The Fall Creek Gorge suspension bridge, ${n} feet long, with a bear walking across">
      <svg viewBox="0 0 250 195">
        <defs>
          <clipPath id="gorge-clip"><rect x="10" y="14" width="230" height="166" rx="10"/></clipPath>
          <linearGradient id="gorge-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe0ea"/><stop offset="1" stop-color="#f3ead6"/></linearGradient>
        </defs>
        <ellipse cx="125" cy="189" rx="104" ry="5" fill="#4a3426" opacity=".18"/>
        <g clip-path="url(#gorge-clip)">
          <rect x="10" y="14" width="230" height="166" fill="url(#gorge-sky)"/>
          <!-- far wall of the gorge -->
          <path d="M10 100 Q80 92 125 104 T240 98 V180 H10 Z" fill="#b89a74" opacity=".55"/>
          <!-- creek with a little waterfall -->
          <path d="M150 112 Q156 135 150 168 L162 168 Q168 135 160 112 Z" fill="#e8f1f6" opacity=".9"/>
          <rect x="10" y="160" width="230" height="20" fill="#6f9fbf"/>
          <path class="art-water" d="M20 168 h14 M48 172 h18 M84 167 h12 M110 172 h16 M140 168 h14 M170 172 h18 M200 167 h12 M224 171 h12" stroke="#e8f1f6" stroke-width="2" stroke-linecap="round"/>
          <!-- cliffs -->
          <path d="M10 82 L68 84 Q74 120 66 150 L80 180 H10 Z" fill="#8a6a48"/>
          <path d="M240 82 L182 84 Q176 118 186 150 L172 180 H240 Z" fill="#8a6a48"/>
          <g stroke="#6e5238" stroke-width="1.5" opacity=".7">
            <line x1="12" y1="104" x2="64" y2="106"/><line x1="12" y1="126" x2="66" y2="128"/><line x1="14" y1="148" x2="64" y2="150"/>
            <line x1="238" y1="104" x2="184" y2="106"/><line x1="238" y1="126" x2="182" y2="128"/><line x1="236" y1="148" x2="186" y2="150"/>
          </g>
          <!-- trees -->
          <g fill="#5d7a4a">
            <polygon points="22,84 30,58 38,84"/><polygon points="36,84 46,50 56,84"/><polygon points="52,84 58,66 64,84"/>
            <polygon points="188,84 196,62 204,84"/><polygon points="202,84 212,52 222,84"/><polygon points="218,84 226,64 234,84"/>
          </g>
          <!-- the bridge -->
          <rect x="66" y="66" width="6" height="20" fill="#4a3426"/>
          <rect x="178" y="66" width="6" height="20" fill="#4a3426"/>
          <path d="M69 68 Q125 114 181 68" fill="none" stroke="#4a3426" stroke-width="2"/>
          <g stroke="#4a3426" stroke-width="1">${hangers}</g>
          <path d="M66 86 Q125 106 184 86" fill="none" stroke="#4a3426" stroke-width="4" stroke-linecap="round"/>
          <!-- a little bear walking across -->
          <g class="art-walker">
            <animateMotion dur="7s" begin="0.6s" repeatCount="indefinite" path="M72 86 Q125 106 178 86"/>
            <g transform="translate(0 -9)">
              <rect x="-4" y="2" width="8" height="8" rx="3" fill="#b31b1b"/>
              <circle cx="0" cy="-1" r="4.5" fill="#9a6544"/>
              <circle cx="-3.2" cy="-4.6" r="1.8" fill="#8a5a3c"/><circle cx="3.2" cy="-4.6" r="1.8" fill="#8a5a3c"/>
            </g>
          </g>
        </g>
        <rect x="10" y="14" width="230" height="166" rx="10" fill="none" stroke="#4a3426" stroke-width="2.5"/>
        <!-- measuring arrow -->
        <g stroke="#b31b1b" stroke-width="2" fill="none" stroke-linecap="round">
          <line x1="72" y1="40" x2="178" y2="40"/>
          <path d="M78 35 L72 40 L78 45 M172 35 L178 40 L172 45"/>
          <line x1="69" y1="34" x2="69" y2="62" stroke-dasharray="2 3"/><line x1="181" y1="34" x2="181" y2="62" stroke-dasharray="2 3"/>
        </g>
        <rect x="100" y="29" width="50" height="21" rx="3" fill="#fffaf0" stroke="#b31b1b" stroke-width="2"/>
        <text x="125" y="44" text-anchor="middle" font-family="Abril Fatface, Georgia, serif" font-size="13" fill="#b31b1b">${n} FT</text>
      </svg>
    </div>`;
  },
  // A sepia 1868 class photo in a frame, with a brass plaque.
  classPhoto: (n) => `
    <div class="promo-art class-photo" role="img" aria-label="A vintage 1868 class photo of ${n} students">
      <svg viewBox="0 0 250 205">
        <defs>
          <linearGradient id="sepia-photo" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#e6d3ad"/><stop offset="1" stop-color="#c4a57a"/>
          </linearGradient>
          <radialGradient id="photo-vignette" cx=".5" cy=".5" r=".7">
            <stop offset=".6" stop-color="#4a3426" stop-opacity="0"/><stop offset="1" stop-color="#4a3426" stop-opacity=".45"/>
          </radialGradient>
        </defs>
        <ellipse cx="125" cy="199" rx="100" ry="5" fill="#4a3426" opacity=".18"/>
        <g transform="rotate(-2 125 95)">
          <rect x="14" y="10" width="222" height="160" rx="4" fill="#6e4a2e"/>
          <rect x="20" y="16" width="210" height="148" rx="2" fill="#8a5a3c"/>
          <rect x="28" y="24" width="194" height="132" fill="#f6ecd6"/>
          <rect x="36" y="32" width="178" height="116" fill="url(#sepia-photo)"/>
          <!-- the first campus building, behind the class -->
          <g fill="#a88a62" opacity=".75">
            <rect x="62" y="48" width="126" height="56"/>
            <polygon points="58,50 125,36 192,50"/>
            <rect x="118" y="30" width="14" height="10"/>
          </g>
          <g fill="#8a6a48" opacity=".7">
            <rect x="72" y="58" width="8" height="12"/><rect x="90" y="58" width="8" height="12"/><rect x="108" y="58" width="8" height="12"/>
            <rect x="134" y="58" width="8" height="12"/><rect x="152" y="58" width="8" height="12"/><rect x="170" y="58" width="8" height="12"/>
          </g>
          ${classRow(92, 11, 50, 15, 1)}
          ${classRow(108, 10, 57, 15, 2)}
          ${classRow(124, 11, 50, 15, 3)}
          <rect x="36" y="32" width="178" height="116" fill="url(#photo-vignette)"/>
          <rect class="art-flash" x="36" y="32" width="178" height="116" fill="#fffdf7"/>
        </g>
        <rect x="74" y="168" width="102" height="26" rx="3" fill="#e2b36f" stroke="#8a5a2b" stroke-width="2"/>
        <circle cx="80" cy="181" r="1.6" fill="#8a5a2b"/><circle cx="170" cy="181" r="1.6" fill="#8a5a2b"/>
        <text x="125" y="179" text-anchor="middle" font-family="Abril Fatface, Georgia, serif" font-size="10" fill="#4a3426">CLASS OF 1868</text>
        <text x="125" y="190" text-anchor="middle" font-family="Special Elite, Courier New, monospace" font-size="8.5" letter-spacing="1" fill="#4a3426">${n} STUDENTS</text>
      </svg>
    </div>`,
  // McGraw Tower (161 steps) with a "161 steps" sign and a bucket list (161 items).
  tower: (n) => `
    <div class="promo-art tower" role="img" aria-label="McGraw Tower beside a sign saying ${n} steps and a bucket list with item ${n} checked off">
      <svg viewBox="0 0 250 220">
        <ellipse cx="128" cy="211" rx="112" ry="6" fill="#4a3426" opacity=".18"/>
        <!-- sign post: 161 steps -->
        <g transform="rotate(-6 42 160)">
          <rect x="38" y="150" width="7" height="58" fill="#8a5a3c"/>
          <rect x="8" y="132" width="68" height="30" rx="3" fill="#c89a72" stroke="#4a3426" stroke-width="2"/>
          <text x="42" y="146" text-anchor="middle" font-family="Abril Fatface, Georgia, serif" font-size="13" fill="#4a3426">${n}</text>
          <text x="42" y="157" text-anchor="middle" font-family="Special Elite, Courier New, monospace" font-size="8.5" letter-spacing="1" fill="#4a3426">STEPS &#8593;</text>
        </g>
        <!-- flag -->
        <line x1="112" y1="16" x2="112" y2="1" stroke="#4a3426" stroke-width="1.6"/>
        <path class="art-flag" d="M112 1 L130 5 L112 10 Z" fill="#b31b1b"/>
        <!-- spire and lantern -->
        <polygon points="112,14 101,42 123,42" fill="#c9b38c" stroke="#4a3426" stroke-width="1.6" stroke-linejoin="round"/>
        <rect x="98" y="42" width="28" height="18" fill="#e2d2ae" stroke="#4a3426" stroke-width="1.6"/>
        <path d="M108 58 V50 a4 4 0 0 1 8 0 V58 Z" fill="#4a3426"/>
        <!-- belfry with two bells -->
        <polygon points="89,60 93,48 97,60" fill="#c9b38c" stroke="#4a3426" stroke-width="1.4"/>
        <polygon points="127,60 131,48 135,60" fill="#c9b38c" stroke="#4a3426" stroke-width="1.4"/>
        <rect x="89" y="60" width="46" height="32" fill="#d9c7a3" stroke="#4a3426" stroke-width="1.6"/>
        <path d="M95 89 V72 Q101 62 107 72 V89 Z" fill="#4a3426"/>
        <path d="M117 89 V72 Q123 62 129 72 V89 Z" fill="#4a3426"/>
        <g class="art-bell"><path d="M97 82 Q97 74 101 74 Q105 74 105 82 Z" fill="#e2b36f"/><circle cx="101" cy="83" r="1.6" fill="#e2b36f"/></g>
        <g class="art-bell two"><path d="M119 82 Q119 74 123 74 Q127 74 127 82 Z" fill="#e2b36f"/><circle cx="123" cy="83" r="1.6" fill="#e2b36f"/></g>
        <rect x="85" y="92" width="54" height="5" fill="#c9b38c" stroke="#4a3426" stroke-width="1.4"/>
        <!-- shaft with clock -->
        <rect x="91" y="97" width="42" height="96" fill="#d9c7a3" stroke="#4a3426" stroke-width="1.6"/>
        <g stroke="#b9a37c" stroke-width="1">
          <line x1="91" y1="130" x2="133" y2="130"/><line x1="91" y1="144" x2="133" y2="144"/>
          <line x1="91" y1="158" x2="133" y2="158"/><line x1="91" y1="172" x2="133" y2="172"/>
          <line x1="112" y1="130" x2="112" y2="144"/><line x1="101" y1="144" x2="101" y2="158"/>
          <line x1="123" y1="144" x2="123" y2="158"/><line x1="112" y1="158" x2="112" y2="172"/>
        </g>
        <circle cx="112" cy="113" r="11" fill="#fffaf0" stroke="#4a3426" stroke-width="1.8"/>
        <path d="M112 113 V106 M112 113 L117 115" stroke="#4a3426" stroke-width="1.8" stroke-linecap="round"/>
        <rect x="108" y="133" width="8" height="9" rx="4" fill="#4a3426" opacity=".7"/>
        <rect x="108" y="161" width="8" height="9" rx="4" fill="#4a3426" opacity=".7"/>
        <!-- base -->
        <rect x="85" y="193" width="54" height="15" fill="#c9b38c" stroke="#4a3426" stroke-width="1.6"/>
        <path d="M106 208 V199 a6 6 0 0 1 12 0 V208 Z" fill="#4a3426"/>
        <!-- bucket list card -->
        <g transform="rotate(7 196 160)">
          <rect x="155" y="108" width="84" height="98" rx="3" fill="#fffaf0" stroke="#4a3426" stroke-width="2"/>
          <rect x="155" y="108" width="84" height="19" rx="3" fill="#b31b1b"/>
          <text x="197" y="121" text-anchor="middle" font-family="Special Elite, Courier New, monospace" font-size="9.5" letter-spacing="1" fill="#fffaf0">BUCKET LIST</text>
          <g font-family="Special Elite, Courier New, monospace" font-size="8" fill="#4a3426">
            <rect x="162" y="134" width="9" height="9" fill="none" stroke="#4a3426" stroke-width="1.3"/>
            <line x1="176" y1="140" x2="230" y2="140" stroke="#b9a37c" stroke-width="2"/>
            <rect x="162" y="151" width="9" height="9" fill="none" stroke="#4a3426" stroke-width="1.3"/>
            <line x1="176" y1="157" x2="222" y2="157" stroke="#b9a37c" stroke-width="2"/>
            <rect x="162" y="168" width="9" height="9" fill="none" stroke="#4a3426" stroke-width="1.3"/>
            <line x1="176" y1="174" x2="228" y2="174" stroke="#b9a37c" stroke-width="2"/>
            <text x="190" y="193" text-anchor="middle" font-size="7">&#8942;</text>
          </g>
          <path class="art-check c1" d="M163 138 l3 4 l6 -8" fill="none" stroke="#1e7a3a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path class="art-check c2" d="M163 155 l3 4 l6 -8" fill="none" stroke="#1e7a3a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path class="art-check c3" d="M163 172 l3 4 l6 -8" fill="none" stroke="#1e7a3a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="166" y="201" font-family="Abril Fatface, Georgia, serif" font-size="12" fill="#b31b1b">No. ${n}</text>
          <path class="art-check c4" d="M213 196 l4 5 l9 -12" fill="none" stroke="#b31b1b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      </svg>
    </div>`,
  // A cartoon bear in a red football jersey with the winning number, waving.
  jersey: (n) => `
    <div class="promo-art jersey" role="img" aria-label="A bear in a red number ${n} jersey, waving">
      <svg viewBox="0 0 220 210">
        <ellipse cx="110" cy="204" rx="84" ry="6" fill="#4a3426" opacity=".18"/>
        <g class="art-wave">
          <path d="M160 128 Q182 110 186 78" fill="none" stroke="#b31b1b" stroke-width="22" stroke-linecap="round"/>
          <path d="M162 126 Q180 112 183 92" fill="none" stroke="#fffaf0" stroke-width="4" stroke-dasharray="0 9 30 200" opacity=".9"/>
          <circle cx="187" cy="70" r="13" fill="#9a6544"/>
          <circle cx="187" cy="67" r="6" fill="#c89a72"/>
        </g>
        <path d="M44 204 V150 Q44 118 78 110 L110 120 L142 110 Q176 118 176 150 V204 Z" fill="#b31b1b"/>
        <path d="M78 110 L110 120 L142 110 L136 106 L110 113 L84 106 Z" fill="#fffaf0"/>
        <path d="M44 150 Q44 126 62 116" fill="none" stroke="#fffaf0" stroke-width="5"/>
        <path d="M176 150 Q176 126 158 116" fill="none" stroke="#fffaf0" stroke-width="5"/>
        <text x="110" y="183" text-anchor="middle" font-family="Abril Fatface, Georgia, serif" font-size="52" fill="#fffaf0" stroke="#4a3426" stroke-width="2.5" paint-order="stroke">${n}</text>
        <path d="M58 150 Q40 168 50 198" fill="none" stroke="#b31b1b" stroke-width="20" stroke-linecap="round"/>
        <circle cx="52" cy="200" r="11" fill="#9a6544"/>
        <circle cx="72" cy="36" r="15" fill="#8a5a3c"/>
        <circle cx="148" cy="36" r="15" fill="#8a5a3c"/>
        <circle cx="72" cy="36" r="7" fill="#c89a72"/>
        <circle cx="148" cy="36" r="7" fill="#c89a72"/>
        <circle cx="110" cy="70" r="40" fill="#9a6544"/>
        <ellipse cx="110" cy="85" rx="18" ry="14" fill="#e3c3a0"/>
        <ellipse cx="110" cy="78" rx="7" ry="5" fill="#3b2a1e"/>
        <path d="M102 88 Q110 95 118 88" fill="none" stroke="#3b2a1e" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="94" cy="63" r="4.5" fill="#3b2a1e"/>
        <circle cx="126" cy="63" r="4.5" fill="#3b2a1e"/>
        <circle cx="95.5" cy="61.5" r="1.4" fill="#fff"/>
        <circle cx="127.5" cy="61.5" r="1.4" fill="#fff"/>
        <circle cx="85" cy="80" r="6" fill="#e88a7a" opacity=".45"/>
        <circle cx="135" cy="80" r="6" fill="#e88a7a" opacity=".45"/>
      </svg>
    </div>`,
};

/** kind: 'announce' | 'live' | 'result'. `then` runs when the button is pressed. */
function showPromo(kind, then, buttonLabel) {
  const promo = state.promo;
  const r = state.promoResult;
  const won = kind === 'result' && Boolean(r?.won);
  const card = $('promo-card');
  card.classList.toggle('win', won);
  // Restart the entrance animations each time.
  card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';

  const count = words(promo?.winners ?? 5);
  const prizeText = promo?.prize ?? r?.prize ?? '';
  const prize = esc(prizeText);
  const day = promo?.date ?? state.daily?.date;
  const set = (kicker, title, body) => {
    $('promo-kicker').innerHTML = kicker;
    $('promo-title').textContent = title;
    $('promo-body').innerHTML = body;
  };
  $('promo-stamp-value').textContent = (prizeText.match(/\$\d+/) || [''])[0];
  $('promo-pm-word').textContent = won ? 'Winner' : 'Giveaway';
  $('promo-pm-date').textContent = day
    ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '';

  if (kind === 'announce') {
    set('&#10022; A thank-you from Guess Cornell &#10022;', 'Giveaway tomorrow!', `
      <p>To thank everyone for playing, <strong>${count} players</strong> will each win a <strong>${prize}</strong> on ${esc(longDate(promo.date))}.</p>
      <p>Every finished puzzle gets the next play number (1st, 2nd, 3rd&hellip;) based on the order of players, and ${count} special Cornell numbers win.</p>
      <p>E.g. If 80 is selected as a special "Cornell" number (for the 80 majors at Cornell), the 80th person to play on ${esc(longDate(promo.date).split(',')[0])} will be selected as a winner.</p>
      <p>Come back tomorrow, play, and see if your number comes up.</p>`);
  } else if (kind === 'live') {
    set('&#10022; Today only &#10022;', "It's giveaway day!", `
      <p><strong>${capital(count)} players</strong> will each win a <strong>${prize}</strong> today.</p>
      ${promo.update ? `<p class="promo-update"><strong>Update:</strong> ${esc(promo.update)}</p>` : ''}
      <p>Every finished puzzle gets the next play number (1st, 2nd, 3rd&hellip;) based on the order of players, and ${count} special Cornell numbers win.</p>
      <p>Finish today's puzzle to find out yours!</p>`);
  } else if (won) {
    const mail = `mailto:${r.email}?subject=${encodeURIComponent(`Guess Cornell giveaway: claim code ${r.code}`)}`
      + `&body=${encodeURIComponent(`Hi! I was player #${r.n} to finish the puzzle. My claim code is ${r.code}.`)}`;
    set('&#10022; Giveaway day &#10022;', 'You won!', `
      ${PROMO_ART[r.art] ? PROMO_ART[r.art](r.n) : `<p class="promo-number">#${r.n}</p>`}
      <p>You were the <strong>${ordinal(r.n)}</strong> player to finish today's puzzle, and ${r.n} is ${esc(r.why)}.</p>
      <p>You've won a <strong>${esc(r.prize)}</strong>!</p>
      <p>Your claim code:<br><span class="promo-code">${esc(r.code)}</span></p>
      <p>Email <a href="${esc(mail)}">${esc(r.email)}</a> with your claim code and we'll send you your digital gift card.</p>
      <p class="small">Take a screenshot so you don't lose your code. It also stays under "See your results" today.</p>`);
  } else {
    const gap = Math.abs(r.n - r.nearest);
    const away = gap <= 15 ? `Just ${gap} away!` : `You were ${gap} away.`;
    // Every winning number before this player (older saved results only know the nearest one).
    const prev = r.previous ?? (r.nearest < r.n ? [{ n: r.nearest, why: r.nearestWhy, art: r.nearestArt }] : []);
    let about;
    if (!prev.length) {
      about = `<p>The first winning number will be <strong>#${r.nearest}</strong>, ${esc(r.nearestWhy)}. ${away}</p>`;
    } else if (prev.length === 1) {
      about = `<p>The winning number before you was <strong>#${prev[0].n}</strong>, ${esc(prev[0].why)}. ${away}</p>`;
    } else {
      about = `<p>The winning numbers before you were:</p>
      <ul class="promo-prev">${prev.map((w) => `<li><strong>#${w.n}</strong>, ${esc(w.why)}</li>`).join('')}</ul>
      <p>${gap <= 15 ? `Just ${gap} away from #${r.nearest}!` : `You were ${gap} away from #${r.nearest}.`}</p>`;
    }
    const arts = (prev.length ? prev : [{ n: r.nearest, art: r.nearestArt }]).filter((w) => PROMO_ART[w.art]);
    set('&#10022; Giveaway day &#10022;', 'Not this time!', `
      <p class="promo-number">#${r.n}</p>
      <p>You were the <strong>${ordinal(r.n)}</strong> player to finish today's puzzle.</p>
      ${about}
      <p>Thanks for playing! Keep playing for chances to win more prizes in the future.</p>
      ${arts.length ? `<div class="promo-art-below${arts.length > 1 ? ' many' : ''}">${arts.map((w) => PROMO_ART[w.art](w.n)).join('')}</div>` : ''}`);
  }
  els.btnPromo.hidden = !buttonLabel;
  els.btnPromo.textContent = buttonLabel || '';
  promoThen = then;
  showScreen('promo');
  $('screen-promo').scrollTop = 0;
  track('promo_view', { kind: kind === 'result' ? (r.won ? 'win' : 'lose') : kind });
}

/**
 * /?promoPreview=announce|live|result&n=161 : the admin page's preview (needs the admin sign-in).
 * promoPreview=winner shows a winner screen without the "Preview" tag.
 */
async function previewPromo(kind) {
  const params = new URLSearchParams(location.search);
  $('promo-preview-tag').hidden = kind === 'winner';
  try {
    const res = await fetch(`/api/admin?view=promoPreview&stage=${encodeURIComponent(kind)}&n=${encodeURIComponent(params.get('n') || '')}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.promo = data.promo;
    state.promoResult = data.promoResult ?? null;
    const result = kind === 'result' || kind === 'winner';
    showPromo(result ? 'result' : kind, null, result ? 'See your score' : 'Continue');
  } catch (err) {
    showStartError(`Preview unavailable: ${err.message} Sign in at /admin first.`);
  }
}

// ---------- Leaderboard ----------

async function showLeaderboard(from) {
  track('leaderboard_view', { from });
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
    const b = await getLeaderboard();
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
