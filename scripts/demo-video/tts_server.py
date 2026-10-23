"""Persistent Kokoro TTS worker: reads JSON lines {voice,text,out,speed}, writes wav, prints {out,seconds}."""
import json, os, sys
import soundfile as sf
from kokoro_onnx import Kokoro

here = os.path.dirname(os.path.abspath(__file__))
k = Kokoro(os.path.join(here, "kokoro-v1.0.onnx"), os.path.join(here, "voices-v1.0.bin"))
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        job = json.loads(line)
        if not os.path.exists(job["out"]):
            samples, sr = k.create(job["text"], voice=job["voice"], speed=job.get("speed", 1.0), lang="en-us")
            sf.write(job["out"], samples, sr)
        info = sf.info(job["out"])
        print(json.dumps({"out": job["out"], "seconds": info.frames / info.samplerate}), flush=True)
    except Exception as e:  # keep serving
        print(json.dumps({"error": str(e)}), flush=True)
