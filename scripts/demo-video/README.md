# Demo video pipeline

The submission video is fully reproducible: a headless Chrome drives ShowBench through its scripting API (`window.showbench.hear()`, `setSpeechHook()`), every line is voiced with the open-source [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) TTS model, frames are captured with timestamps over the DevTools screencast, and `mix.py` lays each voice clip at its logged start time with ffmpeg.

```bash
npm i puppeteer-core @sparticuz/chromium        # headless Chrome
pip install kokoro-onnx soundfile               # + kokoro-v1.0.onnx and voices-v1.0.bin next to tts_server.py
node record.mjs dry && node record.mjs && python3 mix.py
```

Output goes to `./out` (override with `VIDEO_OUT`); the TTS worker defaults to `./tts_server.py` (override with `TTS_SERVER`). Hearth and ShowBench must be running (Hearth with `HEARTH_ROUNDS_INTERVAL_SEC=0` so only the demo clock triggers the care loop).
