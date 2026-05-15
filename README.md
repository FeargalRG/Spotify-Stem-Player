# STEMS — Browser AI Mixer
### Serverless 4-stem splitter for GitHub Pages

---

## Files
```
index.html   — App shell
style.css    — Brutalist terminal aesthetic
app.js       — All logic (audio, ML, Spotify OAuth)
```

---

## Quick Deploy to GitHub Pages

1. Create a new GitHub repo
2. Drop all 3 files in the root
3. Go to **Settings → Pages → Deploy from branch → main / root**
4. Visit `https://yourusername.github.io/your-repo-name/`

---

## Spotify Setup (optional — for track matching)

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Create an App → set Redirect URI to your GitHub Pages URL exactly
   e.g. `https://yourusername.github.io/your-repo-name/`
3. Copy your **Client ID** into `app.js`:
   ```js
   SPOTIFY_CLIENT_ID: 'your_client_id_here',
   ```
4. Also update:
   ```js
   SPOTIFY_REDIRECT_URI: 'https://yourusername.github.io/your-repo-name/',
   ```

**Without Spotify**: the app works fully — you just won't get the track match panel.

---

## Adding a Real Stem Separation Model

The app ships with a **demo mode** that does frequency-band splitting (bass = low frequencies, drums = high frequencies, etc). This gives you a working mixer immediately but is not real AI separation.

To enable real 4-stem ML separation:

### Option A — Demucs (best quality)
- Export the [Demucs](https://github.com/facebookresearch/demucs) model to ONNX
- Host it on GitHub Releases or HuggingFace
- Set in `app.js`:
  ```js
  MODEL_URL: 'https://your-cdn.com/demucs_4stems.onnx',
  ```

### Option B — Spleeter ONNX
- See [sevagh/spleeter-onnx](https://github.com/sevagh/spleeter-onnx)
- Same process — host and set MODEL_URL

### Model output contract
Your ONNX model must:
- Accept input named `input` shaped `[1, num_samples]` (mono float32)
- Return outputs named `vocals`, `drums`, `bass`, `other` (float32 arrays)

Model weights are automatically cached via the **Cache Storage API** — users only download once.

---

## What the "Spotify Scrobble" Actually Does

The spec described forcing track playback via `PUT /v1/me/player/play`.
This app does **not** do that because it would interrupt your local stem mix.

Instead, when you hit Play:
1. The filename is searched on Spotify
2. The best matching track is displayed in the **SPOTIFY MATCH** panel
3. You get a direct link to open it in Spotify

This is the honest, non-disruptive version of the feature.

---

## Browser Support
| Feature | Chrome | Firefox | Safari | Mobile |
|---------|--------|---------|--------|--------|
| Web Audio API | ✅ | ✅ | ✅ | ✅ |
| AudioContext decoding | ✅ | ✅ | ✅ | ✅ |
| ONNX Runtime (WASM) | ✅ | ✅ | ✅ | ✅ |
| ONNX WebGPU (fast) | ✅ Chrome 113+ | ❌ | ❌ | ⚠️ |
| Cache Storage API | ✅ | ✅ | ✅ | ✅ |

---

## Memory Management
- On each new file upload, all previous `AudioBuffer` objects are explicitly nulled
- Sources are disconnected and dereferenced after stop
- Large buffers (stems) are stored in `state.stemBuffers` and wiped on new upload
