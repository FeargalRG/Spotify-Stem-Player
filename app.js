const CONFIG = {
  SC_CLIENT_ID: 'IL7m77BlY76pS8vT5w6bLw5K6Z4z7Z4z',
  PROXY: 'https://corsproxy.io/?'
};

const state = {
  audioCtx: new (window.AudioContext || window.webkitAudioContext)(),
  isPlaying: false,
  // ... (keep your existing state variables here)
};

document.getElementById('btn-search').onclick = async () => {
  const query = document.getElementById('search-input').value;
  if (!query) return;
  
  const searchUrl = `${CONFIG.PROXY}${encodeURIComponent(`https://api-v2.soundcloud.com/search?q=${query}&client_id=${CONFIG.SC_CLIENT_ID}&limit=8`)}`;
  try {
    const resp = await fetch(searchUrl);
    const data = await resp.json();
    renderResults(data.collection);
  } catch (err) {
    alert("Search failed. Try again in a moment.");
  }
};

function renderResults(tracks) {
  const container = document.getElementById('search-results');
  container.innerHTML = '';
  tracks.forEach(track => {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `<img src="${track.artwork_url || track.user.avatar_url}"><p>${track.title}</p>`;
    card.onclick = () => loadTrack(track);
    container.appendChild(card);
  });
}

async function loadTrack(track) {
  document.getElementById('search-section').classList.add('hidden');
  document.getElementById('loading-section').classList.remove('hidden');

  try {
    const media = track.media.transcodings.find(t => t.format.protocol === 'progressive');
    const streamInfo = await fetch(`${CONFIG.PROXY}${encodeURIComponent(`${media.url}?client_id=${CONFIG.SC_CLIENT_ID}`)}`).then(r => r.json());
    
    const audioResp = await fetch(`${CONFIG.PROXY}${encodeURIComponent(streamInfo.url)}`);
    const buffer = await audioResp.arrayBuffer();
    const audioBuffer = await state.audioCtx.decodeAudioData(buffer);
    
    // Call your existing splitAudio function from your original app.js
    if (typeof splitAudio === "function") {
      splitAudio(audioBuffer);
    }
  } catch (err) {
    alert("Track failed to load.");
    location.reload();
  }
}
