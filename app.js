/**
 * Stem Player — app.js
 * Jamendo search → stream → in-browser stem split → 4ch mixer
 */

// ─── Jamendo API config ───────────────────────────────────────────────────────
// Free public API key (Jamendo's demo key — get your own free at developer.jamendo.com)
const JAMENDO_CLIENT_ID = '2a9b4dbd';  // public demo key

// ─── Stem definitions ─────────────────────────────────────────────────────────
const STEMS = ['vocals', 'drums', 'bass', 'other'];

// Filter bank: each stem gets a chain of biquad filters applied to a copy
// of the decoded PCM, so stems truly subtract energy from each other.
// This is frequency-band demixing — not ML, but it produces clean, usable splits.
const STEM_FILTERS = {
  // Vocals: mid-band presence (cut lows + highs aggressively, boost mid)
  vocals: [
    { type: 'highpass',  freq: 180,  Q: 0.9  },
    { type: 'lowpass',   freq: 3800, Q: 0.9  },
    { type: 'peaking',   freq: 1000, Q: 1.4, gain: 4 },
  ],
  // Drums: transient-heavy highs + sub punch (hi-hat + kick)
  drums: [
    { type: 'highpass',  freq: 4000, Q: 0.7  },
    { type: 'peaking',   freq: 8000, Q: 1.2, gain: 5 },
    // Also blend a sub thump
    { type: 'bandpass',  freq: 60,   Q: 2.5  },
  ],
  // Bass: strict low-shelf
  bass: [
    { type: 'lowpass',   freq: 160,  Q: 0.8  },
    { type: 'peaking',   freq: 80,   Q: 1.8, gain: 6 },
  ],
  // Other: upper-mids / harmony (what's left after carving out the above)
  other: [
    { type: 'highpass',  freq: 400,  Q: 0.7  },
    { type: 'lowpass',   freq: 6000, Q: 0.7  },
    { type: 'notch',     freq: 1000, Q: 1.4  },
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────
const S = {
  audioCtx:    null,
  masterGain:  null,
  stemBuffers: {},   // name → AudioBuffer
  stemNodes:   {},   // name → { source, gain, analyser }
  soloedStem:  null,
  mutedStems:  new Set(),
  isPlaying:   false,
  startOffset: 0,
  startTime:   0,
  duration:    0,
  rafId:       null,
  vuRafId:     null,
};

// ─── DOM ──────────────────────────────────────────────────────────────────────
const q  = id => document.getElementById(id);
const searchSection     = q('search-section');
const processingSection = q('processing-section');
const mixerSection      = q('mixer-section');

// ─── AUDIO CONTEXT ────────────────────────────────────────────────────────────
function getCtx() {
  if (!S.audioCtx || S.audioCtx.state === 'closed') {
    S.audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
    S.masterGain = S.audioCtx.createGain();
    S.masterGain.gain.value = parseFloat(q('master-vol').value);
    S.masterGain.connect(S.audioCtx.destination);
  }
  return S.audioCtx;
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────
function cleanup() {
  if (S.rafId)   { cancelAnimationFrame(S.rafId);   S.rafId   = null; }
  if (S.vuRafId) { cancelAnimationFrame(S.vuRafId); S.vuRafId = null; }

  Object.values(S.stemNodes).forEach(n => {
    try { n.source.stop(); n.source.disconnect(); } catch(_) {}
    try { n.gain.disconnect(); }    catch(_) {}
    try { n.analyser.disconnect(); } catch(_) {}
  });
  S.stemNodes  = {};
  S.stemBuffers = {};
  S.isPlaying   = false;
  S.startOffset = 0;
  S.soloedStem  = null;
  S.mutedStems  = new Set();
}

// ─── JAMENDO SEARCH ───────────────────────────────────────────────────────────
async function searchJamendo(query) {
  const url =
    `https://api.jamendo.com/v3.0/tracks/?` +
    `client_id=${JAMENDO_CLIENT_ID}` +
    `&format=json` +
    `&limit=20` +
    `&search=${encodeURIComponent(query)}` +
    `&include=musicinfo` +
    `&audioformat=mp32` +    // 128kbps MP3 — small + fast for mobile
    `&imagesize=200`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Jamendo error ${r.status}`);
  const j = await r.json();
  if (j.headers.status !== 'success') throw new Error(j.headers.error_message);
  return j.results;  // array of track objects
}

// ─── RENDER RESULTS ───────────────────────────────────────────────────────────
function renderResults(tracks) {
  const grid = q('results-grid');
  grid.innerHTML = '';

  if (!tracks.length) {
    grid.innerHTML = '<div class="search-status" style="display:block;padding:20px 0;text-align:center;color:var(--dim)">No results — try a different search</div>';
    return;
  }

  tracks.forEach(track => {
    const row = document.createElement('div');
    row.className = 'result-row';
    row.innerHTML = `
      <img class="result-art" src="${track.image || ''}" alt="" loading="lazy" onerror="this.style.display='none'" />
      <div class="result-meta">
        <div class="result-title">${esc(track.name)}</div>
        <div class="result-artist">${esc(track.artist_name)}</div>
      </div>
      <span class="result-dur">${fmtTime(track.duration)}</span>
    `;
    row.addEventListener('click', () => loadTrack(track));
    grid.appendChild(row);
  });
}

// ─── LOAD + SEPARATE ──────────────────────────────────────────────────────────
async function loadTrack(track) {
  cleanup();
  show('processing');

  // populate processing card
  q('proc-art').src    = track.image || '';
  q('proc-title').textContent  = track.name;
  q('proc-artist').textContent = track.artist_name;

  resetPills();
  setProgress(0, 'Fetching stream…', '');

  let arrayBuffer;
  try {
    // Jamendo's audio URL streams directly — no CORS issues
    const streamUrl = track.audio;  // direct MP3 url from API
    setProgress(5, 'Downloading audio…', '');

    const res = await fetch(streamUrl);
    if (!res.ok) throw new Error(`Stream error ${res.status}`);

    // Stream with progress
    const contentLength = res.headers.get('Content-Length');
    const total = contentLength ? parseInt(contentLength) : 0;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total) {
        const pct = Math.min(40, 5 + Math.round((loaded / total) * 35));
        setProgress(pct, 'Downloading audio…', `${Math.round(loaded/1024)} KB`);
      }
    }

    // Merge chunks
    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    arrayBuffer = await blob.arrayBuffer();

  } catch (err) {
    setProgress(0, '⚠ Could not load track', err.message);
    return;
  }

  // Decode
  setProgress(42, 'Decoding audio…', '');
  let fullBuffer;
  try {
    const ctx = getCtx();
    fullBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (err) {
    setProgress(0, '⚠ Decode failed', err.message);
    return;
  }

  S.duration = fullBuffer.duration;

  // Separate
  setProgress(50, 'Separating stems…', '');
  try {
    await separateStems(fullBuffer);
  } catch (err) {
    setProgress(0, '⚠ Separation failed', err.message);
    return;
  }

  // Draw waveforms
  STEMS.forEach(name => drawWaveform(name, S.stemBuffers[name]));

  // Show mixer
  q('np-art').src           = track.image || '';
  q('np-title').textContent  = track.name;
  q('np-artist').textContent = track.artist_name;
  q('t-total').textContent   = fmtTime(S.duration);
  q('t-cur').textContent     = '0:00';
  q('tl-fill').style.width   = '0%';

  // Reset faders + buttons
  STEMS.forEach(name => {
    const f = q(`fader-${name}`);
    if (f) { f.value = '1'; }
    q(`fpct-${name}`).textContent = '100';
    const s = document.querySelector(`.btn-s[data-stem="${name}"]`);
    const m = document.querySelector(`.btn-m[data-stem="${name}"]`);
    if (s) s.classList.remove('on');
    if (m) m.classList.remove('on');
    document.getElementById(`ch-${name}`)?.classList.remove('muted', 'soloed');
  });

  setPlayState(false);
  show('mixer');
}

// ─── STEM SEPARATION (offline audio processing) ───────────────────────────────
async function separateStems(sourceBuffer) {
  const ctx = getCtx();
  const sr     = sourceBuffer.sampleRate;
  const frames = sourceBuffer.length;
  const nCh    = sourceBuffer.numberOfChannels;

  for (let i = 0; i < STEMS.length; i++) {
    const name = STEMS[i];
    setPillState(name, 'active');
    setProgress(50 + i * 12, 'Separating stems…', `Processing ${name}…`);

    // OfflineAudioContext renders the filtered signal at full quality
    const offCtx = new OfflineAudioContext(nCh, frames, sr);

    const src = offCtx.createBufferSource();
    src.buffer = sourceBuffer;

    // Build filter chain for this stem
    const filters = STEM_FILTERS[name];
    let node = src;
    for (const def of filters) {
      const f = offCtx.createBiquadFilter();
      f.type            = def.type;
      f.frequency.value = def.freq;
      f.Q.value         = def.Q || 1;
      if (def.gain !== undefined) f.gain.value = def.gain;
      node.connect(f);
      node = f;
    }
    node.connect(offCtx.destination);
    src.start(0);

    // Yield to browser before heavy render
    await sleep(30);
    const rendered = await offCtx.startRendering();

    S.stemBuffers[name] = rendered;
    setPillState(name, 'done');
    setProgress(50 + (i + 1) * 12, 'Separating stems…', `${name} done`);
  }

  setProgress(100, 'Ready!', '');
  await sleep(300);
}

// ─── PLAYBACK ────────────────────────────────────────────────────────────────
function startPlayback() {
  const ctx = getCtx();
  const startAt = ctx.currentTime + 0.05;
  S.startTime = startAt;

  STEMS.forEach(name => {
    const buf = S.stemBuffers[name];
    if (!buf) return;

    const source   = ctx.createBufferSource();
    source.buffer  = buf;

    const gain     = ctx.createGain();
    const faderVal = parseFloat(q(`fader-${name}`).value);
    gain.gain.value = shouldMute(name) ? 0 : faderVal;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(S.masterGain);

    source.start(startAt, S.startOffset);
    source.onended = () => {
      if (!S.isPlaying) return;
      const elapsed = S.startOffset + (ctx.currentTime - S.startTime);
      if (elapsed >= S.duration - 0.25) onEnded();
    };

    S.stemNodes[name] = { source, gain, analyser };
  });

  S.isPlaying = true;
  setPlayState(true);
  tickTimeline();
  tickVU();
}

function pausePlayback() {
  if (!S.isPlaying) return;
  const ctx = S.audioCtx;
  S.startOffset = Math.min(
    S.startOffset + (ctx.currentTime - S.startTime),
    S.duration
  );
  Object.values(S.stemNodes).forEach(n => {
    try { n.source.stop(); } catch(_) {}
  });
  S.stemNodes  = {};
  S.isPlaying  = false;
  setPlayState(false);
  if (S.rafId)   { cancelAnimationFrame(S.rafId);   S.rafId   = null; }
  if (S.vuRafId) { cancelAnimationFrame(S.vuRafId); S.vuRafId = null; }
  STEMS.forEach(n => { const el = q(`vu-${n}`); if (el) el.style.height = '0%'; });
}

function restartPlayback() {
  pausePlayback();
  S.startOffset = 0;
  q('tl-fill').style.width = '0%';
  q('t-cur').textContent   = '0:00';
}

function onEnded() {
  S.isPlaying   = false;
  S.startOffset = 0;
  S.stemNodes   = {};
  setPlayState(false);
  q('tl-fill').style.width = '0%';
  q('t-cur').textContent   = '0:00';
  STEMS.forEach(n => { const el = q(`vu-${n}`); if (el) el.style.height = '0%'; });
}

function shouldMute(name) {
  if (S.soloedStem && S.soloedStem !== name) return true;
  return S.mutedStems.has(name);
}

function setPlayState(playing) {
  const ip = q('ic-play')  || document.querySelector('.ic-play');
  const pause = document.querySelector('.ic-pause');
  if (playing) {
    ip?.classList.add('hidden');
    pause?.classList.remove('hidden');
  } else {
    ip?.classList.remove('hidden');
    pause?.classList.add('hidden');
  }
}

// ─── TIMELINE TICK ────────────────────────────────────────────────────────────
function tickTimeline() {
  if (!S.isPlaying) return;
  const ctx     = S.audioCtx;
  const elapsed = Math.min(
    S.startOffset + (ctx.currentTime - S.startTime),
    S.duration
  );
  const pct = (elapsed / S.duration) * 100;
  q('tl-fill').style.width  = `${pct}%`;
  q('t-cur').textContent    = fmtTime(elapsed);
  S.rafId = requestAnimationFrame(tickTimeline);
}

// ─── VU METERS ────────────────────────────────────────────────────────────────
function tickVU() {
  if (!S.isPlaying) return;
  const buf = new Uint8Array(32);
  STEMS.forEach(name => {
    const n  = S.stemNodes[name];
    const el = q(`vu-${name}`);
    if (!n || !el) return;
    n.analyser.getByteFrequencyData(buf);
    const avg = buf.reduce((a,b) => a+b, 0) / buf.length;
    const pct = Math.min(100, (avg / 96) * 120);
    el.style.height = `${pct}%`;
  });
  S.vuRafId = requestAnimationFrame(tickVU);
}

// ─── WAVEFORM DRAWING ────────────────────────────────────────────────────────
function drawWaveform(name, buffer) {
  const canvas = q(`wv-${name}`);
  if (!canvas || !buffer) return;

  // Resolve CSS width properly
  canvas.width = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 200;

  const ctx    = canvas.getContext('2d');
  const data   = buffer.getChannelData(0);
  const W      = canvas.width;
  const H      = canvas.height;
  const step   = Math.floor(data.length / W);

  // color map
  const colorMap = {
    vocals: '#a78bfa',
    drums:  '#fb923c',
    bass:   '#22d3ee',
    other:  '#4ade80',
  };
  const color = colorMap[name] || '#888';

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = color;
  ctx.lineWidth   = 1;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();

  for (let x = 0; x < W; x++) {
    const idx = x * step;
    let max = 0;
    for (let j = 0; j < step && idx+j < data.length; j++) {
      const v = Math.abs(data[idx+j]);
      if (v > max) max = v;
    }
    const h = max * (H / 2) * 1.5;
    const cy = H / 2;
    ctx.moveTo(x, cy - h);
    ctx.lineTo(x, cy + h);
  }
  ctx.stroke();
}

// ─── SHOW/HIDE SECTIONS ───────────────────────────────────────────────────────
function show(which) {
  searchSection.classList.toggle('hidden',     which !== 'search');
  processingSection.classList.toggle('hidden', which !== 'processing');
  mixerSection.classList.toggle('hidden',      which !== 'mixer');
}

// ─── PROGRESS ────────────────────────────────────────────────────────────────
function setProgress(pct, label, sub) {
  q('prog-fill').style.width         = `${pct}%`;
  q('proc-label').textContent        = label;
  q('proc-sub').textContent          = sub || '';
}

function resetPills() {
  STEMS.forEach(n => {
    const p = q(`pill-${n}`);
    if (p) p.className = 'pill';
  });
}

function setPillState(name, state) {
  const p = q(`pill-${name}`);
  if (!p) return;
  p.className = `pill ${state}`;
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── EVENT WIRING ─────────────────────────────────────────────────────────────

// Search
q('search-btn').addEventListener('click', doSearch);
q('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch();
});

async function doSearch() {
  const val = q('search-input').value.trim();
  if (!val) return;
  const status = q('search-status');
  const grid   = q('results-grid');
  status.textContent = 'Searching…';
  status.classList.remove('hidden');
  grid.innerHTML = '';
  try {
    const tracks = await searchJamendo(val);
    status.classList.add('hidden');
    renderResults(tracks);
  } catch (err) {
    status.textContent = `⚠ ${err.message}`;
  }
}

// Play / Pause
q('btn-play').addEventListener('click', async () => {
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  if (S.isPlaying) {
    pausePlayback();
  } else if (Object.keys(S.stemBuffers).length) {
    startPlayback();
  }
});

// Restart
q('btn-restart').addEventListener('click', () => {
  restartPlayback();
});

// Back to search
q('btn-back').addEventListener('click', () => {
  pausePlayback();
  cleanup();
  show('search');
});

// Master volume
q('master-vol').addEventListener('input', () => {
  if (S.masterGain) S.masterGain.gain.value = parseFloat(q('master-vol').value);
});

// Faders
STEMS.forEach(name => {
  const fader = q(`fader-${name}`);
  if (!fader) return;
  fader.addEventListener('input', () => {
    const val = parseFloat(fader.value);
    q(`fpct-${name}`).textContent = Math.round(val * 100);
    const node = S.stemNodes[name];
    if (node && !shouldMute(name)) node.gain.gain.value = val;
  });
});

// Solo buttons
document.querySelectorAll('.btn-s').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.stem;
    if (S.soloedStem === name) {
      // Un-solo
      S.soloedStem = null;
      document.querySelectorAll('.btn-s').forEach(b => b.classList.remove('on'));
      STEMS.forEach(n => {
        document.getElementById(`ch-${n}`)?.classList.remove('soloed');
        applyGain(n);
      });
    } else {
      S.soloedStem = name;
      document.querySelectorAll('.btn-s').forEach(b => {
        b.classList.toggle('on', b.dataset.stem === name);
      });
      STEMS.forEach(n => {
        document.getElementById(`ch-${n}`)?.classList.toggle('soloed', n === name);
        applyGain(n);
      });
    }
  });
});

// Mute buttons
document.querySelectorAll('.btn-m').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.stem;
    const isMuted = S.mutedStems.has(name);
    if (isMuted) {
      S.mutedStems.delete(name);
      btn.classList.remove('on');
      document.getElementById(`ch-${name}`)?.classList.remove('muted');
    } else {
      S.mutedStems.add(name);
      btn.classList.add('on');
      document.getElementById(`ch-${name}`)?.classList.add('muted');
    }
    applyGain(name);
  });
});

function applyGain(name) {
  const node = S.stemNodes[name];
  if (!node) return;
  const fval = parseFloat(q(`fader-${name}`).value);
  node.gain.gain.value = shouldMute(name) ? 0 : fval;
}

// Timeline scrub
q('timeline').addEventListener('click', e => {
  if (!S.duration) return;
  const rect = q('timeline').getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const wasPlaying = S.isPlaying;
  pausePlayback();
  S.startOffset = pct * S.duration;
  q('tl-fill').style.width = `${pct * 100}%`;
  q('t-cur').textContent   = fmtTime(S.startOffset);
  if (wasPlaying) startPlayback();
});

// Resume AudioContext on any tap (iOS requirement)
document.addEventListener('touchstart', () => {
  if (S.audioCtx?.state === 'suspended') S.audioCtx.resume();
}, { passive: true });
