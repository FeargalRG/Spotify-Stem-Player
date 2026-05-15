/**
 * STEMS — Browser AI Mixer
 * app.js
 *
 * Architecture:
 *  - Spotify Implicit Grant OAuth
 *  - Web Audio API stem mixer (4 channels)
 *  - ONNX Runtime Web for ML separation (pluggable model)
 *  - Fallback: frequency-band splitting demo mode
 */

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  // Replace with your actual Spotify app Client ID
  SPOTIFY_CLIENT_ID: 'YOUR_SPOTIFY_CLIENT_ID',
  // Must match your Spotify app's redirect URI exactly
  SPOTIFY_REDIRECT_URI: window.location.href.split('?')[0].split('#')[0],
  SPOTIFY_SCOPES: 'user-modify-playback-state user-read-playback-state',

  // ONNX model URL — swap in a real 4-stem separation model here.
  // Example: a Demucs or Spleeter ONNX export hosted on GitHub Releases or HuggingFace.
  // Set to null to use demo frequency-band split mode.
  MODEL_URL: null, // e.g. 'https://your-cdn.com/demucs_4stems.onnx'

  STEM_COLORS: {
    vocals: 'var(--stem-vocals)',
    drums:  'var(--stem-drums)',
    bass:   'var(--stem-bass)',
    other:  'var(--stem-other)',
  },
  STEM_NAMES: ['vocals', 'drums', 'bass', 'other'],
};

// ============================================================
// STATE
// ============================================================
const state = {
  audioCtx: null,
  masterGain: null,
  stemNodes: {},      // { name: { source, gain, analyser, muted } }
  stemBuffers: {},    // { name: AudioBuffer }
  startOffset: 0,
  startTime: 0,
  isPlaying: false,
  duration: 0,
  rafId: null,
  spotifyToken: null,
  fileName: '',
  trackMetadata: null,
};

// ============================================================
// DOM REFS
// ============================================================
const $ = id => document.getElementById(id);
const uploadSection     = $('upload-section');
const modelSection      = $('model-section');
const separationSection = $('separation-section');
const mixerSection      = $('mixer-section');
const trackMatchSection = $('track-match-section');
const fileInput         = $('file-input');
const dropZone          = $('drop-zone');
const playBtn           = $('play-btn');
const playIcon          = $('play-icon');
const playLabel         = $('play-label');
const masterVol         = $('master-vol');
const timeCurrent       = $('time-current');
const timeTotal         = $('time-total');
const timeBar           = $('time-bar');
const npTitle           = $('np-title');
const mixerGrid         = $('mixer-grid');
const modelBar          = $('model-bar');
const modelPct          = $('model-pct');
const modelNote         = $('model-note');
const sepBar            = $('sep-bar');
const sepPct            = $('sep-pct');
const spotifyBtn        = $('spotify-btn');
const spotifyStatus     = $('spotify-status');
const spotifyUser       = $('spotify-user');

// ============================================================
// SPOTIFY AUTH
// ============================================================
function initSpotify() {
  // Check for token in URL hash (redirect back from Spotify)
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const token = params.get('access_token');

  if (token) {
    const expires = Date.now() + parseInt(params.get('expires_in') || '3600') * 1000;
    localStorage.setItem('spotify_token', token);
    localStorage.setItem('spotify_expires', expires);
    history.replaceState(null, null, window.location.pathname);
    setSpotifyConnected(token);
    return;
  }

  // Check localStorage
  const stored = localStorage.getItem('spotify_token');
  const expires = parseInt(localStorage.getItem('spotify_expires') || '0');
  if (stored && Date.now() < expires) {
    setSpotifyConnected(stored);
    return;
  }

  spotifyBtn.classList.remove('hidden');
}

function setSpotifyConnected(token) {
  state.spotifyToken = token;
  spotifyBtn.classList.add('hidden');
  spotifyStatus.classList.remove('hidden');
  // Fetch user profile
  fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${token}` }
  })
  .then(r => r.json())
  .then(user => {
    spotifyUser.textContent = user.display_name || 'Connected';
  })
  .catch(() => {});
}

spotifyBtn.addEventListener('click', () => {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', CONFIG.SPOTIFY_CLIENT_ID);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', CONFIG.SPOTIFY_REDIRECT_URI);
  url.searchParams.set('scope', CONFIG.SPOTIFY_SCOPES);
  url.searchParams.set('show_dialog', 'false');
  window.location.href = url.toString();
});

// ============================================================
// FILE HANDLING
// ============================================================
fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  // Cleanup previous session
  cleanupAudio();

  state.fileName = file.name.replace(/\.[^/.]+$/, '');
  npTitle.textContent = state.fileName;

  uploadSection.classList.add('hidden');
  mixerSection.classList.add('hidden');
  trackMatchSection.classList.add('hidden');

  // Decode audio
  const arrayBuffer = await file.arrayBuffer();
  const ctx = getAudioContext();
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (err) {
    alert('Could not decode audio file. Please try an MP3 or WAV.');
    uploadSection.classList.remove('hidden');
    return;
  }

  state.duration = audioBuffer.duration;

  // Spotify search (fire and forget)
  if (state.spotifyToken) {
    searchSpotify(state.fileName);
  }

  // Separate
  await separateStems(audioBuffer);
}

// ============================================================
// AUDIO CONTEXT
// ============================================================
function getAudioContext() {
  if (!state.audioCtx || state.audioCtx.state === 'closed') {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.masterGain = state.audioCtx.createGain();
    state.masterGain.connect(state.audioCtx.destination);
  }
  return state.audioCtx;
}

function cleanupAudio() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.isPlaying = false;

  // Stop all sources
  Object.values(state.stemNodes).forEach(({ source }) => {
    try { source.stop(); source.disconnect(); } catch (e) {}
  });
  state.stemNodes = {};

  // Null out buffers for GC
  Object.keys(state.stemBuffers).forEach(k => { state.stemBuffers[k] = null; });
  state.stemBuffers = {};

  state.startOffset = 0;
  state.startTime = 0;
}

// ============================================================
// STEM SEPARATION
// ============================================================
async function separateStems(audioBuffer) {
  // Show model loading section
  modelSection.classList.remove('hidden');

  let separatedBuffers;

  if (CONFIG.MODEL_URL) {
    separatedBuffers = await separateWithONNX(audioBuffer);
  } else {
    // Demo mode: frequency-band split
    separatedBuffers = await separateDemo(audioBuffer);
  }

  modelSection.classList.add('hidden');
  separationSection.classList.add('hidden');

  // Store buffers
  state.stemBuffers = separatedBuffers;

  buildMixerUI();
  mixerSection.classList.remove('hidden');
  playBtn.disabled = false;
}

// ── ONNX separation (plug in a real model) ──
async function separateWithONNX(audioBuffer) {
  setModelProgress(5, 'Checking model cache...');

  // Use Cache Storage API to avoid re-downloading
  const CACHE_NAME = 'stems-model-v1';
  let modelData;

  try {
    const cache = await caches.open(CACHE_NAME);
    let cachedResponse = await cache.match(CONFIG.MODEL_URL);

    if (!cachedResponse) {
      setModelProgress(10, 'Downloading model weights (first time only)...');
      // Stream download with progress
      const response = await fetch(CONFIG.MODEL_URL);
      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength) : 0;
      let loaded = 0;
      const reader = response.body.getReader();
      const chunks = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total) setModelProgress(10 + Math.floor((loaded / total) * 70), 'Downloading...');
      }

      const blob = new Blob(chunks);
      await cache.put(CONFIG.MODEL_URL, new Response(blob));
      modelData = await blob.arrayBuffer();
    } else {
      setModelProgress(80, 'Loading from cache...');
      modelData = await cachedResponse.arrayBuffer();
    }
  } catch (e) {
    console.warn('Cache API unavailable, fetching directly');
    setModelProgress(20, 'Fetching model...');
    const r = await fetch(CONFIG.MODEL_URL);
    modelData = await r.arrayBuffer();
  }

  setModelProgress(90, 'Initializing inference engine...');

  // ONNX Runtime Web
  if (typeof ort === 'undefined') {
    await loadScript('https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js');
  }

  // Try WebGPU → WebGL → WASM fallback
  for (const ep of ['webgpu', 'webgl', 'wasm']) {
    try {
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
      const session = await ort.InferenceSession.create(modelData, {
        executionProviders: [ep]
      });
      setModelProgress(100, `Running on ${ep.toUpperCase()}`);
      return await runONNXInference(session, audioBuffer);
    } catch (e) {
      console.warn(`EP ${ep} failed:`, e.message);
    }
  }
  throw new Error('All ONNX execution providers failed');
}

async function runONNXInference(session, audioBuffer) {
  // Convert to mono float32 PCM
  const pcm = audioBuffer.getChannelData(0);
  const CHUNK = 44100 * 10; // 10s chunks
  const numChunks = Math.ceil(pcm.length / CHUNK);
  const stems = { vocals: [], drums: [], bass: [], other: [] };

  separationSection.classList.remove('hidden');

  for (let i = 0; i < numChunks; i++) {
    const chunk = pcm.slice(i * CHUNK, (i + 1) * CHUNK);
    const tensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
    const results = await session.run({ input: tensor });

    // Expected output names: 'vocals', 'drums', 'bass', 'other'
    CONFIG.STEM_NAMES.forEach(name => {
      stems[name].push(results[name]?.data || new Float32Array(chunk.length));
    });

    const pct = Math.round(((i + 1) / numChunks) * 100);
    setSepProgress(pct);
    setStageActive(i % 4);
  }

  // Concatenate chunks into AudioBuffers
  const ctx = getAudioContext();
  const result = {};
  CONFIG.STEM_NAMES.forEach(name => {
    const combined = concatFloat32(stems[name]);
    const buf = ctx.createBuffer(1, combined.length, audioBuffer.sampleRate);
    buf.copyToChannel(combined, 0);
    result[name] = buf;
  });
  return result;
}

// ── Demo separation: frequency bands ──
async function separateDemo(audioBuffer) {
  setModelProgress(100, 'Demo mode — using frequency band split');
  modelSection.classList.add('hidden');
  separationSection.classList.remove('hidden');

  const ctx = getAudioContext();
  const sr = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const rawL = audioBuffer.getChannelData(0);
  const rawR = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : rawL;

  // Simulate processing delay in chunks with progress
  const CHUNK = Math.floor(frames / 20);
  for (let i = 0; i < 20; i++) {
    await sleep(60);
    setSepProgress(Math.round((i + 1) * 5));
    setStageActive(Math.floor(i / 5));
  }

  // Simple frequency-band approximation using offline context + biquad filters
  const stems = {};
  const defs = [
    { name: 'vocals',  type: 'bandpass', freq: 800,   Q: 0.5  },
    { name: 'drums',   type: 'highpass', freq: 5000,  Q: 0.7  },
    { name: 'bass',    type: 'lowpass',  freq: 150,   Q: 0.8  },
    { name: 'other',   type: 'bandpass', freq: 2000,  Q: 0.4  },
  ];

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    setStageActive(i);
    setSepProgress(20 + i * 20);

    const offCtx = new OfflineAudioContext(2, frames, sr);
    const src = offCtx.createBufferSource();
    src.buffer = audioBuffer;
    const filter = offCtx.createBiquadFilter();
    filter.type = def.type;
    filter.frequency.value = def.freq;
    filter.Q.value = def.Q;
    src.connect(filter);
    filter.connect(offCtx.destination);
    src.start();
    stems[def.name] = await offCtx.startRendering();
    await sleep(80);
  }

  setSepProgress(100);
  markAllStagesDone();
  await sleep(400);
  return stems;
}

// ============================================================
// MIXER UI
// ============================================================
function buildMixerUI() {
  mixerGrid.innerHTML = '';

  CONFIG.STEM_NAMES.forEach(name => {
    const color = CONFIG.STEM_COLORS[name];

    const ch = document.createElement('div');
    ch.className = 'stem-channel';
    ch.dataset.stem = name;
    ch.style.setProperty('--stem-color', color);

    ch.innerHTML = `
      <div class="stem-label">${name.toUpperCase()}</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <div class="slider-container">
          <input type="range" class="stem-fader" id="fader-${name}"
            min="0" max="1" step="0.01" value="1"
            aria-label="${name} volume" />
        </div>
        <div class="vu-meter"><div class="vu-fill" id="vu-${name}" style="height:0%"></div></div>
      </div>
      <div class="stem-db" id="db-${name}">0 dB</div>
      <button class="stem-mute" id="mute-${name}">MUTE</button>
    `;
    mixerGrid.appendChild(ch);

    // Fader → GainNode
    const fader = ch.querySelector(`#fader-${name}`);
    fader.addEventListener('input', () => {
      const val = parseFloat(fader.value);
      if (state.stemNodes[name]) {
        state.stemNodes[name].gain.gain.value = val;
      }
      updateDB(name, val);
    });

    // Mute button
    const muteBtn = ch.querySelector(`#mute-${name}`);
    muteBtn.addEventListener('click', () => {
      const node = state.stemNodes[name];
      if (!node) return;
      node.muted = !node.muted;
      node.gain.gain.value = node.muted ? 0 : parseFloat(fader.value);
      muteBtn.classList.toggle('muted', node.muted);
      muteBtn.textContent = node.muted ? 'UNMUTE' : 'MUTE';
    });
  });

  timeTotal.textContent = formatTime(state.duration);
}

function updateDB(name, val) {
  const el = $(`db-${name}`);
  if (!el) return;
  if (val === 0) { el.textContent = '-∞ dB'; return; }
  const db = Math.round(20 * Math.log10(val));
  el.textContent = `${db > 0 ? '+' : ''}${db} dB`;
}

// ============================================================
// PLAYBACK
// ============================================================
playBtn.addEventListener('click', togglePlay);

async function togglePlay() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  if (state.isPlaying) {
    pauseAll();
  } else {
    await playAll();
  }
}

async function playAll() {
  const ctx = getAudioContext();

  // Reconnect master gain
  if (state.masterGain) {
    state.masterGain.disconnect();
    state.masterGain.connect(ctx.destination);
  }

  // Sync start time
  const startAt = ctx.currentTime + 0.05;
  state.startTime = startAt;

  CONFIG.STEM_NAMES.forEach(name => {
    const buffer = state.stemBuffers[name];
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    const fader = $(`fader-${name}`);
    gain.gain.value = fader ? parseFloat(fader.value) : 1;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(state.masterGain);

    source.start(startAt, state.startOffset);
    source.onended = () => {
      if (state.isPlaying && state.startOffset + (ctx.currentTime - state.startTime) >= state.duration - 0.1) {
        stopAll();
      }
    };

    // Check if was muted
    const muteBtn = $(`mute-${name}`);
    const muted = muteBtn && muteBtn.classList.contains('muted');
    if (muted) gain.gain.value = 0;

    state.stemNodes[name] = { source, gain, analyser, muted };
  });

  state.isPlaying = true;
  playIcon.textContent = '⏸';
  playLabel.textContent = 'PAUSE';
  playBtn.classList.add('playing');

  // Spotify search-and-display on play
  if (state.spotifyToken && !state.trackMetadata) {
    searchSpotify(state.fileName);
  }

  startVUMeters();
  startTimeTracker();
}

function pauseAll() {
  if (!state.isPlaying) return;
  const ctx = state.audioCtx;
  // Capture current position
  state.startOffset += ctx.currentTime - state.startTime;
  if (state.startOffset > state.duration) state.startOffset = 0;

  Object.values(state.stemNodes).forEach(({ source }) => {
    try { source.stop(); source.disconnect(); } catch (e) {}
  });
  state.stemNodes = {};
  state.isPlaying = false;

  playIcon.textContent = '▶';
  playLabel.textContent = 'PLAY';
  playBtn.classList.remove('playing');

  if (state.rafId) cancelAnimationFrame(state.rafId);
}

function stopAll() {
  pauseAll();
  state.startOffset = 0;
  timeBar.style.width = '0%';
  timeCurrent.textContent = '0:00';
}

// Master volume
masterVol.addEventListener('input', () => {
  if (state.masterGain) {
    state.masterGain.gain.value = parseFloat(masterVol.value);
  }
});

// ============================================================
// VU METERS & TIME
// ============================================================
function startVUMeters() {
  if (state.rafId) cancelAnimationFrame(state.rafId);

  function tick() {
    CONFIG.STEM_NAMES.forEach(name => {
      const node = state.stemNodes[name];
      const vuEl = $(`vu-${name}`);
      if (!node || !vuEl) return;
      const data = new Uint8Array(node.analyser.frequencyBinCount);
      node.analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const pct = Math.min(100, (avg / 128) * 100 * 1.5);
      vuEl.style.height = `${pct}%`;
    });

    state.rafId = requestAnimationFrame(tick);
  }
  state.rafId = requestAnimationFrame(tick);
}

function startTimeTracker() {
  function tick() {
    if (!state.isPlaying) return;
    const ctx = state.audioCtx;
    const elapsed = state.startOffset + (ctx.currentTime - state.startTime);
    const pct = Math.min(100, (elapsed / state.duration) * 100);
    timeBar.style.width = `${pct}%`;
    timeCurrent.textContent = formatTime(elapsed);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ============================================================
// SPOTIFY SEARCH
// ============================================================
async function searchSpotify(query) {
  if (!state.spotifyToken) return;
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${state.spotifyToken}` } }
    );
    if (!res.ok) throw new Error('Search failed');
    const data = await res.json();
    const track = data?.tracks?.items?.[0];
    if (!track) return;

    state.trackMetadata = track;
    showTrackMatch(track);
  } catch (e) {
    console.warn('Spotify search error:', e);
  }
}

function showTrackMatch(track) {
  $('track-name').textContent = track.name;
  $('track-artist').textContent = track.artists.map(a => a.name).join(', ');
  const img = track.album?.images?.[1] || track.album?.images?.[0];
  if (img) $('track-art').src = img.url;
  $('track-link').href = track.external_urls?.spotify || '#';
  trackMatchSection.classList.remove('hidden');
}

// ============================================================
// PROGRESS HELPERS
// ============================================================
function setModelProgress(pct, note) {
  modelBar.style.width = `${pct}%`;
  modelPct.textContent = `${pct}%`;
  if (note) modelNote.textContent = note;
}

function setSepProgress(pct) {
  sepBar.style.width = `${pct}%`;
  sepPct.textContent = `${pct}%`;
}

function setStageActive(idx) {
  CONFIG.STEM_NAMES.forEach((name, i) => {
    const el = $(`stage-${name}`);
    if (!el) return;
    el.className = 'stage';
    if (i < idx) el.classList.add('done');
    else if (i === idx) el.classList.add('active');
  });
}

function markAllStagesDone() {
  CONFIG.STEM_NAMES.forEach(name => {
    const el = $(`stage-${name}`);
    if (el) { el.className = 'stage done'; }
  });
}

// ============================================================
// UTILS
// ============================================================
function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function concatFloat32(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  arrays.forEach(a => { out.set(a, offset); offset += a.length; });
  return out;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ============================================================
// INIT
// ============================================================
initSpotify();

// Resume AudioContext on any user gesture (required by browsers)
document.addEventListener('click', () => {
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
}, { once: false });

console.log('%cSTEMS — Browser AI Mixer', 'font-size:20px;font-weight:bold;color:#c8f135;');
console.log('%cSet CONFIG.MODEL_URL to a real ONNX model for true stem separation.', 'color:#888;');
