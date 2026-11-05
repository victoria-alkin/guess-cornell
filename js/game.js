import { CONFIG } from './config.js';
import { distanceMeters, scoreForDistance, formatDistance, formatPoints } from './scoring.js';
import { createMap, pinIcon, resetView } from './map.js';
import { loadLocations, pickRounds, panoUrlFor } from './locations.js';

const $ = (id) => document.getElementById(id);

const els = {
  btnStart: $('btn-start'),
  startError: $('start-error'),
  hudRound: $('hud-round'),
  hudTimer: $('hud-timer'),
  hudTimerItem: $('hud-timer-item'),
  hudScore: $('hud-score'),
  timerFill: $('timer-fill'),
  guessPanel: $('guess-panel'),
  mapCover: $('map-cover'),
  mapCollapse: $('map-collapse'),
  btnGuess: $('btn-guess'),
  resultCard: $('result-card'),
  resultPlace: $('result-place'),
  resultPoints: $('result-points'),
  resultBar: $('result-bar'),
  resultDistance: $('result-distance'),
  btnNext: $('btn-next'),
  summaryCard: $('summary-card'),
  summaryTotal: $('summary-total'),
  summaryMax: $('summary-max'),
  summaryRows: $('summary-rows'),
  btnAgain: $('btn-again'),
};

const state = {
  locations: [],
  rounds: [],
  index: 0,
  results: [],
  guess: null,        // {lat, lng} or null
  submitted: false,
  viewer: null,
  timerId: null,
  deadline: 0,
  roundToken: 0,      // guards against stale async callbacks between rounds
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

// ---------- Setup ----------

async function init() {
  $('rule-rounds').textContent = CONFIG.roundsPerGame;
  $('rule-time').textContent = `${CONFIG.roundTimeSeconds}s`;
  $('rule-points').textContent = formatPoints(CONFIG.scoring.maxPoints);

  try {
    state.locations = await loadLocations(CONFIG.locationsUrl);
  } catch (err) {
    console.error(err);
    els.btnStart.textContent = 'Unavailable';
    els.startError.hidden = false;
    els.startError.textContent =
      location.protocol === 'file:'
        ? 'Open this through a local web server, not as a file. See README.md.'
        : `Couldn't load locations: ${err.message}`;
    return;
  }

  els.btnStart.disabled = false;
  els.btnStart.textContent = 'Start game';
  els.btnStart.addEventListener('click', startGame);
  els.btnGuess.addEventListener('click', () => submitGuess(false));
  els.btnNext.addEventListener('click', nextRound);
  els.btnAgain.addEventListener('click', startGame);
  els.mapCover.addEventListener('click', () => setMapExpanded(true));
  els.mapCollapse.addEventListener('click', () => setMapExpanded(false));
  els.guessPanel.addEventListener('transitionend', (e) => {
    if (e.target === els.guessPanel) guessMap?.invalidateSize();
  });
  els.guessPanel.addEventListener('mouseenter', () => setTimeout(() => guessMap?.invalidateSize(), 220));
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.key !== 'Enter') return;
  const active = document.querySelector('.screen.active')?.id;
  if (active === 'screen-round' && state.guess && !state.submitted) submitGuess(false);
  else if (active === 'screen-result' && !els.resultCard.hidden) nextRound();
}

// ---------- Game flow ----------

function startGame() {
  state.rounds = pickRounds(state.locations, CONFIG.roundsPerGame);
  state.index = 0;
  state.results = [];
  startRound();
}

async function startRound() {
  const token = ++state.roundToken;
  const loc = state.rounds[state.index];
  state.guess = null;
  state.submitted = false;

  showScreen('round');
  els.hudRound.textContent = `${state.index + 1} / ${state.rounds.length}`;
  els.hudScore.textContent = formatPoints(totalScore());
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
  const url = await panoUrlFor(loc, state.index);
  if (token !== state.roundToken) return;

  state.viewer = pannellum.viewer('pano', {
    type: 'equirectangular',
    panorama: url,
    autoLoad: true,
    yaw: loc.startYaw ?? Math.random() * 360 - 180,
    hfov: 100,
    minHfov: 40,
    maxHfov: 120,
    showFullscreenCtrl: false,
    compass: false,
  });
  // Clock starts once the photo is visible, so slow downloads don't eat time.
  const begin = () => { if (token === state.roundToken && !state.timerId && !state.submitted) startTimer(); };
  state.viewer.on('load', begin);
  state.viewer.on('error', begin);
}

function placeGuess(latlng) {
  if (state.submitted) return;
  state.guess = { lat: latlng.lat, lng: latlng.lng };
  if (guessMarker) guessMarker.setLatLng(latlng);
  else guessMarker = L.marker(latlng, { icon: pinIcon('guess'), interactive: false }).addTo(guessMap);
  setGuessButton();
}

function setGuessButton() {
  els.btnGuess.disabled = !state.guess;
  els.btnGuess.textContent = state.guess ? 'Guess' : 'Place a pin on the map';
}

function setMapExpanded(on) {
  els.guessPanel.classList.toggle('expanded', on);
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

// ---------- Guessing & results ----------

function submitGuess(timedOut) {
  if (state.submitted) return;
  state.submitted = true;
  stopTimer();

  const loc = state.rounds[state.index];
  // If time runs out with a pin on the map, that pin counts as the guess.
  const guess = state.guess;
  const distance = guess ? distanceMeters(guess, loc) : null;
  const points = guess ? scoreForDistance(distance) : 0;
  state.results.push({ loc, guess, distance, points, timedOut });

  showResult();
}

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
  const r = state.results[state.results.length - 1];
  showScreen('result');
  els.resultCard.hidden = false;
  els.summaryCard.hidden = true;

  ensureResultMap();
  fitTo(drawPair(r));

  els.resultPlace.textContent = r.loc.name || 'Mystery spot';
  els.resultDistance.textContent = r.guess
    ? `Your guess was ${formatDistance(r.distance)} away${r.timedOut ? ' (time ran out)' : ''}.`
    : "Time's up. No guess was placed.";
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
  els.resultCard.hidden = true;
  els.summaryCard.hidden = false;

  ensureResultMap();
  const pts = state.results.flatMap((r, i) => drawPair(r, String(i + 1)));
  fitTo(pts);

  els.summaryMax.textContent = formatPoints(state.rounds.length * CONFIG.scoring.maxPoints);
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
