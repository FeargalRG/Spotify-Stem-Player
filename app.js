const SC_CLIENT_ID = 'IL7m77BlY76pS8vT5w6bLw5K6Z4z7Z4z';
const PROXY = 'https://corsproxy.io/?'; // Clean, reliable proxy

const state = {
  audioCtx: new (window.AudioContext || window.webkitAudioContext)(),
  sources: {},
  gains: {},
  isPlaying: false,
};

// SEARCH LOGIC
document.getElementById('btn-search').onclick = async () => {
  const query = document.getElementById('search-input').value;
  if (!query) return;
  
  const searchUrl = `${PROXY}${encodeURIComponent(`https://api-v2.soundcloud.com/search?q=${query}&client_id=${SC_CLIENT_ID}&limit=8`)}`;
  const resp = await fetch(searchUrl);
  const data = await resp.json();
  renderResults(data.collection);
};

function renderResults(tracks) {
  const container = document.getElementById('search-results');
  container.innerHTML = '';
  tracks.forEach(track => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `<img src="${track.artwork_url || track.user.avatar_url}"><p>${track.title}</p>`;
    card.onclick = () => processTrack(track);
    container.appendChild(card);
  });
}

async function processTrack(track) {
  document.getElementById('search-section').classList.add('hidden');
  document.getElementById('loading-section').classList.remove('hidden');

  try {
    // 1. Get Streaming URL
    const mediaUrl = track.media.transcodings.find(t => t.format.protocol === 'progressive').url;
    const streamData = await fetch(`${PROXY}${encodeURIComponent(`${mediaUrl}?client_id=${SC_CLIENT_ID}`)}`).then(r => r.json());
    
    // 2. Fetch Audio Data
    const audioResp = await fetch(`${PROXY}${encodeURIComponent(streamData.url)}`);
    const buffer = await audioResp.arrayBuffer();
    const audioBuffer = await state.audioCtx.decodeAudioData(buffer);
    
    // 3. Hand off to splitting logic (Reuse your existing spectral splitting code here)
    startMixer(audioBuffer); 
  } catch (err) {
    alert("Error loading track. Try another one.");
    location.reload();
  }
}

function startMixer(buffer) {
  document.getElementById('loading-section').classList.add('hidden');
  document.getElementById('mixer-section').classList.remove('hidden');
  // ... Initialize your 4-channel crossover filters and gain nodes here ...
  console.log("Mixer ready with full track!");
}