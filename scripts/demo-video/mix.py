"""Assemble the demo video: timestamped JPEG frames + voice clips placed at logged times -> MP4."""
import json, os, subprocess, sys

V = os.environ.get("VIDEO_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
frames = json.load(open(f"{V}/frames.json"))
ev = json.load(open(f"{V}/events.json"))
total = ev["total"] / 1000
out = sys.argv[1] if len(sys.argv) > 1 else f"{V}/hearth-demo.mp4"

# Video: concat demuxer with per-frame durations (frames only arrive when the screen changes).
frames = [f for f in frames if os.path.exists(f["file"])]
frames.sort(key=lambda f: f["t"])
with open(f"{V}/frames.txt", "w") as fh:
    for i, f in enumerate(frames):
        start = max(0.0, f["t"] / 1000)
        end = frames[i + 1]["t"] / 1000 if i + 1 < len(frames) else total
        dur = max(0.001, end - start)
        if end <= 0:
            continue
        fh.write(f"file '{f['file']}'\nduration {dur:.4f}\n")
    fh.write(f"file '{frames[-1]['file']}'\n")

# Audio: each clip delayed to its logged start.
inputs, filters = [], []
for i, e in enumerate(ev["events"]):
    inputs += ["-i", e["file"]]
    ms = max(0, int(e["t"]))
    vol = 1.0 if e["role"] == "narrator" else 0.95
    filters.append(f"[{i + 1}:a]aresample=48000,volume={vol},adelay={ms}|{ms}[a{i}]")
mix = "".join(f"[a{i}]" for i in range(len(ev["events"])))
filters.append(f"{mix}amix=inputs={len(ev['events'])}:normalize=0:dropout_transition=0,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11[aout]")

cmd = [
    "ffmpeg", "-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", f"{V}/frames.txt",
    *inputs,
    "-filter_complex", ";".join(filters),
    "-map", "0:v", "-map", "[aout]",
    "-vf", "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k",
    "-t", f"{total:.3f}", "-movflags", "+faststart", out,
]
subprocess.run(cmd, check=True)
print(f"{out}  {total:.1f}s  frames={len(frames)} clips={len(ev['events'])}")
