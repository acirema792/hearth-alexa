// Records the Hearth demo video: drives ShowBench headlessly, voices every line with Kokoro TTS,
// logs when each line starts, then mixes audio onto the screencast with ffmpeg.
//   node record.mjs dry   → run once, collect Alexa's lines, pre-generate all speech
//   node record.mjs       → record for real (all speech cached, so timing is exact)
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const DRY = process.argv[2] === "dry";
const OUT = "/home/claude/work/video";
const CACHE = `${OUT}/tts`;
mkdirSync(CACHE, { recursive: true });
const VOICES = { narrator: "af_heart", alexa: "af_bella", rosa: "bf_emma", daniel: "am_michael" };
const SPEED = { narrator: 1.0, alexa: 1.05, rosa: 0.95, daniel: 1.0 };
const REPO = process.env.REPO_URL ?? "github.com/hearth-alexa";

// ------------------------------------------------------------------ TTS worker
const tts = spawn("python3", ["/home/claude/work/tts/tts_server.py"], { stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: tts.stdout });
const waiting = [];
lines.on("line", (l) => {
  const j = JSON.parse(l);
  if (j.ready) return;
  waiting.shift()?.(j);
});
function clean(text) {
  return text.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, "").replace(/\s+/g, " ").trim();
}
async function speech(role, text) {
  text = clean(text);
  const file = `${CACHE}/${role}-${createHash("sha1").update(role + text).digest("hex").slice(0, 12)}.wav`;
  const p = new Promise((r) => waiting.push(r));
  tts.stdin.write(JSON.stringify({ voice: VOICES[role], speed: SPEED[role], text, out: file }) + "\n");
  const r = await p;
  if (r.error) throw new Error(r.error);
  return { file, ms: Math.round(r.seconds * 1000) };
}

// ------------------------------------------------------------------ browser
const browser = await puppeteer.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, "--hide-scrollbars"],
  headless: true,
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
const post = (path, body) => fetch(`http://localhost:8787${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
await post("/demo/reset", { set: "08:20" });
await page.goto("http://localhost:5173/", { waitUntil: "networkidle2" });
await page.waitForFunction(() => document.querySelector("#server-name")?.textContent?.includes("Hearth"), { timeout: 15000 });

const events = []; // {t, file}
let t0 = Date.now();
const now = () => Date.now() - t0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.exposeFunction("__speak", async (text) => {
  const s = await speech("alexa", text);
  events.push({ t: now() + 120, file: s.file, role: "alexa", text });
  return s.ms + 250;
});
await page.evaluate(() => window.showbench.setSpeechHook((t) => window.__speak(t)));

// Overlay layer for narration subtitles and title cards.
await page.addStyleTag({
  content: `
  #narr { position: fixed; left: 40px; bottom: 26px; width: 1080px; background: rgba(23,32,58,.94); color: #f3e9dc; font: 500 25px/1.35 ui-rounded, "Nunito", "Segoe UI", system-ui, sans-serif; padding: 14px 22px; border-radius: 16px; opacity: 0; transition: opacity .3s; z-index: 50; border-left: 6px solid #f2c14e; }
  #narr.show { opacity: 1; }
  #rec-card { position: fixed; inset: 0; z-index: 60; background: radial-gradient(circle at 30% 20%, #24345f, #17203a 65%); color: #f3e9dc; display: grid; align-content: center; padding: 0 160px; gap: 26px; opacity: 0; transition: opacity .6s; font-family: ui-rounded, "Nunito", "Segoe UI", system-ui, sans-serif; }
  #rec-card.show { opacity: 1; }
  #rec-card h1 { font: 400 112px/1 "Iowan Old Style", Palatino, Georgia, serif; margin: 0; }
  #rec-card .sub { font-size: 40px; color: #c9bfb3; }
  #rec-card .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-top: 30px; }
  #rec-card .fact { border-top: 4px solid #f2c14e; padding-top: 14px; font-size: 27px; line-height: 1.3; }
  #rec-card .fact b { display: block; font-size: 46px; color: #fff; margin-bottom: 4px; }
  #rec-card .fact:nth-child(2) { border-color: #e46a86; } #rec-card .fact:nth-child(3) { border-color: #8fc1a0; }
  #rec-card .note { font-size: 22px; color: #9c968e; margin-top: 18px; }
  #rec-card .arch { display: grid; grid-template-columns: 1fr 70px 1.25fr 70px 1fr; align-items: center; margin-top: 10px; }
  #rec-card .box { border: 2px solid rgba(243,233,220,.35); border-radius: 22px; padding: 22px; font-size: 23px; line-height: 1.45; background: rgba(255,255,255,.04); }
  #rec-card .box h3 { margin: 0 0 8px; font-size: 30px; color: #fff; }
  #rec-card .box.mid { border-color: #f2c14e; }
  #rec-card .arrow { text-align: center; font-size: 40px; color: #f2c14e; }
  #rec-card .foot { display: flex; justify-content: space-between; font-size: 26px; color: #c9bfb3; margin-top: 20px; }
  `,
});
await page.evaluate(() => {
  for (const id of ["narr", "rec-card"]) {
    const d = document.createElement("div");
    d.id = id;
    document.body.append(d);
  }
});
const card = (html) => page.evaluate((h) => { const c = document.getElementById("rec-card"); if (h) { c.innerHTML = h; c.classList.add("show"); } else c.classList.remove("show"); }, html);

async function narrate(text, { keep = false } = {}) {
  const s = await speech("narrator", text);
  await page.evaluate((t) => { const n = document.getElementById("narr"); n.textContent = t; n.classList.add("show"); }, text);
  events.push({ t: now(), file: s.file, role: "narrator", text });
  await sleep(s.ms + 350);
  if (!keep) await page.evaluate(() => document.getElementById("narr").classList.remove("show"));
}
async function person(role, text) {
  const s = await speech(role, text);
  events.push({ t: now() + 60, file: s.file, role, text });
  await page.evaluate((t, ms) => window.showbench.hear(t, ms), text, s.ms + 200);
  await page.waitForFunction(() => !window.showbench.isBusy(), { timeout: 60000, polling: 100 });
  await sleep(250);
}
async function clickInApp(sel) {
  for (const f of page.frames()) {
    const el = await f.$(sel).catch(() => null);
    if (el) {
      await el.evaluate((e) => e.click());
      return;
    }
  }
  console.error("no element", sel);
}
async function companionType(text) {
  const f = page.frames().find((x) => x.url().includes("/companion"));
  await f.type("#msg", text, { delay: 35 });
  await sleep(300);
  await f.$eval("#compose button", (b) => b.click());
}
async function waitIdle(extra = 0) {
  await sleep(400);
  await page.waitForFunction(() => !window.showbench.isBusy(), { timeout: 60000, polling: 100 });
  await sleep(extra);
}

// ------------------------------------------------------------------ the script
// Capture timestamped JPEG frames via the DevTools screencast; encode offline afterwards.
const frames = [];
let cdp = null;
if (!DRY) {
  const { rmSync } = await import("node:fs");
  rmSync(`${OUT}/frames`, { recursive: true, force: true });
  mkdirSync(`${OUT}/frames`, { recursive: true });
  cdp = await page.createCDPSession();
  cdp.on("Page.screencastFrame", async (f) => {
    const file = `${OUT}/frames/${String(frames.length).padStart(6, "0")}.jpg`;
    frames.push({ file, t: f.metadata.timestamp * 1000 - t0 });
    writeFileSync(file, Buffer.from(f.data, "base64"));
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
}
t0 = Date.now();

await card(`<h1>Hearth</h1><div class="sub">A care circle for Alexa+</div>
  <div class="facts">
    <div class="fact"><b>2025</b>Amazon retired Alexa Together, its remote-caregiving service</div>
    <div class="fact"><b>63 million</b>Americans are family caregivers (AARP &amp; NAC, 2025)</div>
    <div class="fact"><b>MCP + MCP Apps</b>Self-hosted server, spec 2025-11-25, Streamable HTTP</div>
  </div>
  <div class="note">Demo runs on a simulated Alexa+ Echo Show (ShowBench, open source). Demo clock and sandbox pharmacy.</div>`);
await sleep(600);
await narrate("In 2025, Amazon retired Alexa Together. But sixty-three million Americans still care for someone they love, often from far away. Hearth brings that care circle back to Alexa plus.");
await card(null);
await sleep(700);

await narrate("Meet Rosa. She's seventy-eight and lives alone in Tucson. On the right: her son Daniel's phone, in Seattle.");
await person("rosa", "Alexa, what's on today?");
await person("rosa", "Alexa, I took my morning pills.");
await narrate("Daniel's phone updates instantly.");
await person("rosa", "Alexa, let's do my check-in.");
await sleep(600);
for (const sel of [".choice.c1", ".choice.c2", ".choice.c2"]) {
  await clickInApp(sel);
  await sleep(1100);
}
await sleep(1200);
await narrate("She mentions pain. Hearth doesn't diagnose. It tells Daniel a call might help.");
await person("rosa", "Alexa, did I take my metformin? I can't remember.");
await narrate("The double-dose guard lives in the server, not in a prompt.");
await narrate("Hearth also watches her supply.");
await person("rosa", "Alexa, order more metformin.");
await person("rosa", "Yes, please.");
await narrate("A real purchase: quote, read-back, explicit yes.");

await narrate("Evening now. The seven o'clock pill isn't logged.");
await post("/demo/clock", { set: "19:35" });
await waitIdle(800);
await narrate("Nobody asked. Hearth spoke up on its own, through an MCP resource subscription.");
await post("/demo/clock", { set: "20:05" });
await sleep(1500);
await narrate("Half an hour later, Daniel gets a nudge and sends a note.");
await companionType("Mom, did you take your evening pill? Love you");
await waitIdle(600);
await person("rosa", "Oh! Alexa, I took my metformin.");
await sleep(1800);
await narrate("Daniel gets the all-clear. No anxious phone call needed.");

await page.evaluate(() => { window.showbench.setDevice("show15"); window.showbench.setDeviceLabel("Daniel's living room, Seattle"); });
await sleep(600);
await person("daniel", "Alexa, how's Mom doing this week?");
await sleep(1500);

await card(`<div class="sub" style="font-size:34px;color:#f3e9dc">Under the hood</div>
  <div class="arch">
    <div class="box"><h3>Alexa+ device</h3>Voice + Echo Show<br>MCP Apps host<br>Subscribes to announcements<br><span style="color:#9c968e">(ShowBench in this demo)</span></div>
    <div class="arrow">⇄</div>
    <div class="box mid"><h3>Hearth MCP server</h3>Spec 2025-11-25 · Streamable HTTP<br>14 tools with safety annotations<br>4 MCP Apps views + app-only tools<br>resources/subscribe for proactive speech<br>Agent Skill with the care rules</div>
    <div class="arrow">⇄</div>
    <div class="box"><h3>Services</h3>Family push / SMS webhook<br>Pharmacy refills (sandbox)<br>Durable care record<br>Care loop every 15 min</div>
  </div>
  <div class="foot"><span>9 end-to-end tests over real Streamable HTTP</span><span>${REPO}</span></div>`);
await sleep(500);
await narrate("Under the hood: an MCP server on the 2025-11-25 spec over Streamable HTTP, with fourteen annotated tools, four MCP Apps views, resource subscriptions for proactive speech, and an Agent Skill. ShowBench, the simulator, is open source.", { keep: false });
await card(`<h1>Hearth</h1><div class="sub">Care that keeps the family close.</div><div class="note" style="font-size:26px">${REPO} · ShowBench: open-source MCP Apps device simulator</div>`);
await narrate("Hearth. Care that keeps the family close.");
await sleep(1200);

const total = now();
if (cdp) await cdp.send("Page.stopScreencast");
writeFileSync(`${OUT}/frames.json`, JSON.stringify(frames));
await browser.close();
tts.stdin.end();
writeFileSync(`${OUT}/${DRY ? "dry" : "events"}.json`, JSON.stringify({ total, events }, null, 2));
console.log(`${DRY ? "dry run" : "recorded"}: ${(total / 1000).toFixed(1)}s, ${events.length} voice lines`);
