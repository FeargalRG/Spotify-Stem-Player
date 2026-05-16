/**
 * Stem Player — app.js
 * File upload → decode → 4-stem frequency split → Web Audio mixer
 */

'use strict';

// ─── STEM CONFIG ─────────────────────────────────────────────────────────────
const STEMS = ['vocals', 'drums', 'bass', 'other'];

const COLORS = {
  vocals: '#a78bfa',
  drums:  '#fb923c',
  bass:   '#22d3ee',
  other:  '#4ade80',
};

/**
 * Multi-stage biquad filter chains per stem.
 * Each stem is rendered independently via OfflineAudioContext so filters
 * never bleed into each other's render pass.
 *
 * Strategy:
 *  vocals — bandpass 200-3500 Hz (human voice presence), notch out sub + air
 *  drums  — highpass 5kHz (cymbals/snare crack) + separate sub bandpass (kick)
 *           then we ADD those two renders together in JS
 *  bass   — lowpass 200 Hz, boost sub shelf
 *  other  — bandpass 400-8kHz, notch out the vocal band
 */
const FILTERS = {
  vocals: [
    { type: 'highpass', freq: 200,  Q: 0.8 },
    { type: 'lowpass',  freq: 3500, Q: 0.8 },
    { type: 'peaking',  freq: 900,  Q: 1.5, gain: 3 },
    { type: 'peaking',  freq: 2500, Q: 1.2, gain: 2 },
  ],
  drums: [
    // high shelf for snap/crack
    { type: 'highpass', freq: 4500, Q: 0.7 },
    { type: 'peaking',  freq: 9000, Q: 1.0, gain: 4 },
  ],
  // drums also gets a kick sub path — handled specially below
  bass: [
    { type: 'lowpass',  freq: 200,  Q: 0.9 },
    { type: 'peaking',  freq: 80,   Q: 2.0, gain: 5 },
    { type: 'peaking',  freq: 40,   Q: 1.5, gain: 3 },
  ],
  other: [
    { type: 'highpass', freq: 380,  Q: 0.7 },
    { type: 'lowpass',  freq: 7000, Q: 0.7 },
    { type: 'notch',    freq: 900,  Q: 1.5 },   // carve out vocal fundamental
  ],
};

// Separate kick-sub path for drums (blended after rendering)
const KICK_FILTERS = [
  { type: 'bandpass', freq: 65,  Q: 2.5 },
  { type: 'peaking',  freq: 65,  Q: 2.0, gain: 8 },
];

// ─── STATE ───────────────────────────────────────────────────────────────────
const S = {
  ctx:         null,   // AudioContext
  masterGain:  null,
  stemBuffers: {},     // stem → AudioBuffer
  stemNodes:   {},     // stem → { source, gain, analyser }
  soloedStem:  null,
  mutedStems:  new Set(),
  isPlaying:   false,
  startOffset: 0,
  startTime:   0,
  duration:    0,
  rafTL:       null,
  rafVU:       null,
};

// ─── DOM HELPERS ─────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const uploadSection     = $('upload-section');
const processingSection = $('processing-section');
const mixerSection      = $('mixer-section');

// ─── AUDIO CONTEXT ───────────────────────────────────────────────────────────
function getCtx() {
  if (!S.ctx || S.ctx.state === 'closed') {
    S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    S.masterGain = S.ctx.createGain();
    S.masterGain.gain.value = parseFloat($('master-vol').value);
    S.masterGain.connect(S.ctx.destination);
  }
  return S.ctx;
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────
function cleanup() {
  if (S.rafTL) { cancelAnimationFrame(S.rafTL); S.rafTL = null; }
  if (S.rafVU) { cancelAnimationFrame(S.rafVU); S.rafVU = null; }

  Object.values(S.stemNodes).forEach(n => {
    try { n.source.stop(); } catch (_) {}
    try { n.source.disconnect(); n.gain.disconnect(); n.analyser.disconnect(); } catch (_) {}
  });

  // Null out for GC — critical on mobile
  S.stemNodes  = {};
  S.stemBuffers = {};
  S.isPlaying   = false;
  S.startOffset = 0;
  S.soloedStem  = null;
  S.mutedStems  = new Set();
}

// ─── FILE INPUT — THE FIXED VERSION ──────────────────────────────────────────
// We wire BOTH the native change event AND a manual listener on the zone div.
// The <input> sits absolutely over the entire drop zone with opacity:0 so
// every tap/click on the zone naturally hits the input — no JS trickery needed.
// The dragover/drop handlers below add extra desktop DnD support.

function initUpload() {
  const fileInput = $('file-input');
  const dropZone  = $('drop-zone');

  // Primary: native file input change event
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleFile(file);
    // reset so same file can be re-selected
    fileInput.value = '';
  });

  // Desktop drag-and-drop
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
}

// ─── HANDLE FILE ─────────────────────────────────────────────────────────────
async function handleFile(file) {
  // Validate type loosely
  if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(file.name)) {
    alert('Please choose an audio file (MP3, WAV, OGG, FLAC).');
    return;
  }

  cleanup();
  show('processing');

  const name = file.name.replace(/\.[^/.]+$/, '');  // strip extension
  $('proc-filename').textContent = name;
  $('mixer-title').textContent   = name;
  resetPills();
  setProgress(0, 'Reading file…');

  // 1. Read as ArrayBuffer
  let arrayBuffer;
  try {
    arrayBuffer = await readFileAsArrayBuffer(file, pct => {
      setProgress(Math.round(pct * 20), 'Reading file…');
    });
  } catch (err) {
    return showError('Could not read file: ' + err.message);
  }

  // 2. Decode audio
  setProgress(22, 'Decoding audio…');
  let fullBuffer;
  try {
    const ctx = getCtx();
    // decodeAudioData needs a detached copy (it consumes the buffer)
    fullBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch (err) {
    return showError('Decode failed — is this a valid audio file?');
  }

  S.duration = fullBuffer.duration;

  // 3. Separate
  try {
    await separateStems(fullBuffer);
  } catch (err) {
    return showError('Stem separation error: ' + err.message);
  }

  // 4. Draw waveforms (after section is visible so canvas has real width)
  show('mixer');
  $('t-total').textContent = fmtTime(S.duration);
  $('t-cur').textContent   = '0:00';
  $('tl-played').style.width = '0%';
  resetMixerControls();

  // requestAnimationFrame so the DOM has rendered and canvases have width
  requestAnimationFrame(() => {
    STEMS.forEach(s => drawWaveform(s, S.stemBuffers[s]));
  });
}

function readFileAsArrayBuffer(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress  = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    reader.onload      = e => resolve(e.target.result);
    reader.onerror     = () => reject(new Error('FileReader error'));
    reader.readAsArrayBuffer(file);
  });
}

// ─── STEM SEPARATION ─────────────────────────────────────────────────────────
async function separateStems(sourceBuffer) {
  const sr     = sourceBuffer.sampleRate;
  const frames = sourceBuffer.length;
  const nCh    = sourceBuffer.numberOfChannels;

  for (let i = 0; i < STEMS.length; i++) {
    const stem = STEMS[i];
    setPill(stem, 'active');
    setProgress(25 + i * 18, `Processing ${stem}…`);

    // Give browser a breath between heavy renders
    await sleep(20);

    let rendered;

    if (stem === 'drums') {
      // Drums = hi-freq render + kick sub render, then mix
      const hiRender   = await renderFiltered(sourceBuffer, FILTERS.drums,  sr, frames, nCh);
      const kickRender = await renderFiltered(sourceBuffer, KICK_FILTERS,    sr, frames, nCh);
      rendered = mixBuffers(hiRender, kickRender, sr, nCh, 1.0, 0.7);
    } else {
      rendered = await renderFiltered(sourceBuffer, FILTERS[stem], sr, frames, nCh);
    }

    S.stemBuffers[stem] = rendered;
    setPill(stem, 'done');
  }

  setProgress(100, 'Done!');
  await sleep(250);
}

/** Run a filter chain on sourceBuffer via OfflineAudioContext */
async function renderFiltered(sourceBuffer, filterDefs, sr, frames, nCh) {
  const offCtx = new OfflineAudioContext(nCh, frames, sr);

  const src = offCtx.createBufferSource();
  src.buffer = sourceBuffer;

  let node = src;
  for (const def of filterDefs) {
    const f = offCtx.createBiquadFilter();
    f.type            = def.type;
    f.frequency.value = def.freq;
    f.Q.value         = def.Q   ?? 1;
    if (def.gain !== undefined) f.gain.value = def.gain;
    node.connect(f);
    node = f;
  }
  node.connect(offCtx.destination);
  src.start(0);

  return offCtx.startRendering();
}

/** Add two AudioBuffers sample-by-sample with individual gain */
function mixBuffers(a, b, sr, nCh, gainA, gainB) {
  const out = new AudioBuffer({ numberOfChannels: nCh, length: a.length, sampleRate: sr });
  for (let c = 0; c < nCh; c++) {
    const da  = a.getChannelData(c);
    const db  = b.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < dst.length; i++) {
      dst[i] = da[i] * gainA + db[i] * gainB;
    }
  }
  return out;
}

// ─── PLAYBACK ────────────────────────────────────────────────────────────────
function startPlayback() {
  const ctx = getCtx();
  const startAt = ctx.currentTime + 0.04;
  S.startTime = startAt;

  STEMS.forEach(stem => {
    const buf = S.stemBuffers[stem];
    if (!buf) return;

    const source   = ctx.createBufferSource();
    source.buffer  = buf;

    const gain     = ctx.createGain();
    const faderVal = parseFloat($(`fader-${stem}`).value);
    gain.gain.value = isMuted(stem) ? 0 : faderVal;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.6;

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(S.masterGain);

    source.start(startAt, S.startOffset);
    source.onended = () => {
      if (!S.isPlaying) return;
      const pos = S.startOffset + (ctx.currentTime - S.startTime);
      if (pos >= S.duration - 0.3) handleEnded();
    };

    S.stemNodes[stem] = { source, gain, analyser };
  });

  S.isPlaying = true;
  setPlayUI(true);
  loopTimeline();
  loopVU();
}

function pausePlayback() {
  if (!S.isPlaying) return;
  // Capture exact playhead position before stopping
  S.startOffset = Math.min(
    S.startOffset + (S.ctx.currentTime - S.startTime),
    S.duration
  );
  Object.values(S.stemNodes).forEach(n => { try { n.source.stop(); } catch (_) {} });
  S.stemNodes = {};
  S.isPlaying = false;
  setPlayUI(false);
  cancelAnimationFrame(S.rafTL); S.rafTL = null;
  cancelAnimationFrame(S.rafVU); S.rafVU = null;
  STEMS.forEach(s => { const el = $(`vu-${s}`); if (el) el.style.height = '0%'; });
}

function restartPlayback() {
  const wasPlaying = S.isPlaying;
  pausePlayback();
  S.startOffset = 0;
  $('tl-played').style.width = '0%';
  $('t-cur').textContent     = '0:00';
  if (wasPlaying) startPlayback();
}

function handleEnded() {
  S.isPlaying   = false;
  S.startOffset = 0;
  S.stemNodes   = {};
  setPlayUI(false);
  $('tl-played').style.width = '0%';
  $('t-cur').textContent     = '0:00';
  STEMS.forEach(s => { const el = $(`vu-${s}`); if (el) el.style.height = '0%'; });
}

function isMuted(stem) {
  if (S.soloedStem && S.soloedStem !== stem) return true;
  return S.mutedStems.has(stem);
}

function applyGain(stem) {
  const node = S.stemNodes[stem];
  if (!node) return;
  node.gain.gain.value = isMuted(stem) ? 0 : parseFloat($(`fader-${stem}`).value);
}

// ─── ANIMATION LOOPS ─────────────────────────────────────────────────────────
function loopTimeline() {
  if (!S.isPlaying) return;
  const elapsed = Math.min(S.startOffset + (S.ctx.currentTime - S.startTime), S.duration);
  $('tl-played').style.width = `${(elapsed / S.duration) * 100}%`;
  $('t-cur').textContent     = fmtTime(elapsed);
  S.rafTL = requestAnimationFrame(loopTimeline);
}

function loopVU() {
  if (!S.isPlaying) return;
  const tmp = new Uint8Array(32);
  STEMS.forEach(stem => {
    const n  = S.stemNodes[stem];
    const el = $(`vu-${stem}`);
    if (!n || !el) return;
    n.analyser.getByteFrequencyData(tmp);
    const avg = tmp.reduce((a, b) => a + b, 0) / tmp.length;
    el.style.height = `${Math.min(100, (avg / 90) * 130)}%`;
  });
  S.rafVU = requestAnimationFrame(loopVU);
}

// ─── WAVEFORM ────────────────────────────────────────────────────────────────
function drawWaveform(stem, buffer) {
  const canvas = $(`wv-${stem}`);
  if (!canvas || !buffer) return;

  const W = canvas.offsetWidth || 180;
  canvas.width  = W;
  canvas.height = 40;

  const ctx  = canvas.getContext('2d');
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  const H    = 40;
  const mid  = H / 2;

  ctx.clearRect(0, 0, W, H);

  // background
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, W, H);

  // waveform bars
  ctx.strokeStyle = COLORS[stem];
  ctx.lineWidth   = 1.2;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();

  for (let x = 0; x < W; x++) {
    let peak = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[x * step + j] || 0);
      if (v > peak) peak = v;
    }
    const h = peak * mid * 1.6;
    ctx.moveTo(x + 0.5, mid - h);
    ctx.lineTo(x + 0.5, mid + h);
  }
  ctx.stroke();
}

// ─── UI HELPERS ──────────────────────────────────────────────────────────────
function show(which) {
  uploadSection.classList.toggle('hidden',     which !== 'upload');
  processingSection.classList.toggle('hidden', which !== 'processing');
  mixerSection.classList.toggle('hidden',      which !== 'mixer');
}

function setPlayUI(playing) {
  document.querySelector('.ic-play') ?.classList.toggle('hidden',  playing);
  document.querySelector('.ic-pause')?.classList.toggle('hidden', !playing);
}

function setProgress(pct, label) {
  $('prog-fill').style.width  = `${pct}%`;
  $('proc-stage').textContent = label || '';
  $('proc-pct').textContent   = `${Math.round(pct)}%`;
}

function resetPills() {
  STEMS.forEach(s => { const p = $(`pill-${s}`); if (p) p.className = 'pill'; });
}
function setPill(stem, state) {
  const p = $(`pill-${stem}`); if (p) p.className = `pill ${state}`;
}

function resetMixerControls() {
  STEMS.forEach(stem => {
    const f = $(`fader-${stem}`);
    if (f) f.value = '1';
    const v = $(`fv-${stem}`);
    if (v) v.textContent = '100';
    $$('.btn-s, .btn-m').forEach(b => b.classList.remove('on'));
    $(`ch-${stem}`)?.classList.remove('muted', 'soloed');
  });
}

function showError(msg) {
  $('proc-stage').textContent = '⚠ ' + msg;
  $('proc-pct').textContent   = '';
  $('prog-fill').style.background = '#ef4444';
}

// ─── UTILS ───────────────────────────────────────────────────────────────────
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── EVENT WIRING ────────────────────────────────────────────────────────────
initUpload();

// Play / Pause
$('btn-play').addEventListener('click', async () => {
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  if (S.isPlaying) {
    pausePlayback();
  } else if (Object.keys(S.stemBuffers).length > 0) {
    startPlayback();
  }
});

// Restart
$('btn-restart').addEventListener('click', restartPlayback);

// Load new track
$('btn-eject').addEventListener('click', () => {
  pausePlayback();
  cleanup();
  show('upload');
});

// Master volume
$('master-vol').addEventListener('input', () => {
  if (S.masterGain) S.masterGain.gain.value = parseFloat($('master-vol').value);
});

// Per-stem faders
STEMS.forEach(stem => {
  $(`fader-${stem}`)?.addEventListener('input', function () {
    const val = parseFloat(this.value);
    $(`fv-${stem}`).textContent = Math.round(val * 100);
    applyGain(stem);
  });
});

// Solo
$$('.btn-s').forEach(btn => {
  btn.addEventListener('click', () => {
    const stem = btn.dataset.stem;
    if (S.soloedStem === stem) {
      S.soloedStem = null;
      $$('.btn-s').forEach(b => b.classList.remove('on'));
      STEMS.forEach(s => { $(`ch-${s}`)?.classList.remove('soloed'); applyGain(s); });
    } else {
      S.soloedStem = stem;
      $$('.btn-s').forEach(b => b.classList.toggle('on', b.dataset.stem === stem));
      STEMS.forEach(s => { $(`ch-${s}`)?.classList.toggle('soloed', s === stem); applyGain(s); });
    }
  });
});

// Mute
$$('.btn-m').forEach(btn => {
  btn.addEventListener('click', () => {
    const stem = btn.dataset.stem;
    if (S.mutedStems.has(stem)) {
      S.mutedStems.delete(stem);
      btn.classList.remove('on');
      $(`ch-${stem}`)?.classList.remove('muted');
    } else {
      S.mutedStems.add(stem);
      btn.classList.add('on');
      $(`ch-${stem}`)?.classList.add('muted');
    }
    applyGain(stem);
  });
});

// Timeline scrub (click + touch)
function scrub(e) {
  if (!S.duration) return;
  const bar    = $('timeline');
  const rect   = bar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const pct    = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const was    = S.isPlaying;
  pausePlayback();
  S.startOffset = pct * S.duration;
  $('tl-played').style.width = `${pct * 100}%`;
  $('t-cur').textContent     = fmtTime(S.startOffset);
  if (was) startPlayback();
}
$('timeline').addEventListener('click',      scrub);
$('timeline').addEventListener('touchstart', scrub, { passive: true });

// iOS AudioContext resume
document.addEventListener('touchstart', () => {
  if (S.ctx?.state === 'suspended') S.ctx.resume();
}, { passive: true });
