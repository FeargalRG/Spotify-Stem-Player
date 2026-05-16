# Spotify Stem Player (Jamendo Edition)

A high-performance, 100% serverless, client-side web application designed to search, stream, and separate audio tracks into 4 distinct mixing stems directly within a mobile or desktop browser. 

This version drops all rigid Spotify developer dashboard requirements, local MP3 file constraints, and the fragile nature of unauthenticated SoundCloud scraping in favor of a robust integration with the **Jamendo Music API**.

---

## ⚡ Key Features

* **Zero-Auth Search & Stream:** Type an artist or track name to dynamically scan Jamendo's public library. It fetches full-length high-quality audio streams without forcing you to log into an external service or manage an app dashboard.
* **100% Client-Side Architecture:** Designed to fit perfectly within **GitHub Pages**. No local Python servers, Node.js backends, or desktop dependencies required. Everything operates directly out of your phone or desktop browser.
* **Multi-Stage Spectral Separation:** Bypasses complex, resource-heavy in-browser ML files by routing full-track audio buffers through a dedicated `OfflineAudioContext`. Each stem uses targeted multi-stage biquad filtering chains:
    * **Vocals:** Isolated via highpass -> lowpass -> peaking EQ combinations focusing on the core vocal presence band.
    * **Drums:** High-frequency transient bandpass extraction.
    * **Bass:** Hard low-pass containment isolating pure low-end rhythm sections (< 250Hz).
    * **Other:** High-pass and structural remnants covering synth, guitar, and melodic backbones.
* **Vibrant Pro Mixer Interface:** Formatted in bold Helvetica Neue typography. Features 4 prominent, mobile-optimized vertical touch faders, per-stem solo/mute buttons, individual dB readouts, live canvas-driven VU meters, and timeline scratching controls.

---

## 📁 Project Architecture

The app is built using a highly efficient single-page application (SPA) design framework: