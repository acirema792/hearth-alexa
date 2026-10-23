import { connectView, h, mount, svg, relTime, STATUS_WORDS, type Payload } from "./shared";

let app: Awaited<ReturnType<typeof connectView>>;
let last: Payload | null = null;
let busy = false;

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const nowMinutes = (label: string) => {
  // "8:52 AM" -> minutes of day
  const m = label.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 12 * 60;
  let hr = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") hr += 12;
  return hr * 60 + Number(m[2]);
};

/** The day as a sun arc from 6 AM to 10 PM. Each dose is a bead on the arc; the sun is "now". */
function sunArc(board: Payload) {
  const W = 1000, H = 190, start = 6 * 60, end = 22 * 60;
  const pos = (min: number) => {
    const t = Math.min(1, Math.max(0, (min - start) / (end - start)));
    const x = 40 + t * (W - 80);
    const y = H - 30 - Math.sin(t * Math.PI) * (H - 70);
    return { x, y };
  };
  const path: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const p = pos(start + ((end - start) * i) / 60);
    path.push(`${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  const now = pos(nowMinutes(board.nowLabel));
  const nodes: SVGElement[] = [
    svg("path", { d: path.join(" "), class: "arc" }),
    svg("line", { x1: 20, x2: W - 20, y1: H - 30, y2: H - 30, class: "horizon" }),
  ];
  // Group doses by time so a shared slot shows as one bead with a count.
  const slots = new Map<string, Payload[]>();
  for (const d of board.doses) slots.set(d.time, [...(slots.get(d.time) ?? []), d]);
  const glow = svg("circle", { cx: now.x, cy: now.y, r: 30, class: "sun-glow" });
  nodes.push(glow, svg("circle", { cx: now.x, cy: now.y, r: 14, class: "sun" }));
  for (const [time, ds] of slots) {
    const p = pos(toMin(time));
    const rank = ["missed", "late", "due", "upcoming", "skipped", "taken"];
    const worst = ds.map((d) => d.status).sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0];
    nodes.push(svg("circle", { cx: p.x, cy: p.y, r: 19, class: `bead ${worst}` }));
    const label = svg("text", { x: p.x, y: p.y + 48, class: "bead-label", "text-anchor": "middle" });
    label.textContent = ds[0].timeLabel.replace(":00", "");
    nodes.push(label);
    if (ds.length > 1) {
      const c = svg("text", { x: p.x, y: p.y + 6, class: "bead-count", "text-anchor": "middle" });
      c.textContent = String(ds.length);
      nodes.push(c);
    } else if (worst === "taken") {
      nodes.push(svg("path", { d: `M${p.x - 8},${p.y} l5,6 l11,-12`, class: "tick" }));
    }
  }
  return svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "arcbox", role: "img", "aria-label": `Today's doses on a timeline; it is ${board.nowLabel}` }, ...nodes);
}

async function takeDose(dose: Payload, button: HTMLButtonElement) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = await app.callServerTool({ name: "log_medication", arguments: { medication: dose.medId, time: dose.time } });
    const data = result.structuredContent as Payload;
    render(data);
    // Keep the voice assistant in the loop: the tap happened on screen, not in conversation.
    await app.updateModelContext({ content: [{ type: "text", text: `On the display, Rosa tapped "I took it" for ${dose.name} (${dose.timeLabel}).` }] }).catch(() => {});
  } finally {
    busy = false;
  }
}

function doseRow(d: Payload, actionable: boolean) {
  const btn = h("button", { class: "take", type: "button" }, "I took it") as HTMLButtonElement;
  btn.addEventListener("click", () => takeDose(d, btn));
  return h(
    "li",
    { class: `dose ${d.status}` },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h(
      "div",
      { class: "dose-text" },
      h("div", { class: "dose-name" }, `${d.name} `, h("span", { class: "strength" }, d.strength)),
      h("div", { class: "dose-meta" }, `${d.purpose} · ${d.timeLabel}`, d.status === "taken" && d.loggedAtLabel ? ` · taken ${d.loggedAtLabel}` : ""),
    ),
    actionable ? btn : h("span", { class: `pill ${d.status}` }, STATUS_WORDS[d.status] ?? d.status),
  );
}

function render(data: Payload) {
  const board = data.board ?? last?.board;
  if (!board) return;
  last = data;
  const open = board.doses.filter((d: Payload) => ["due", "late", "missed"].includes(d.status));
  const rest = board.doses.filter((d: Payload) => !["due", "late", "missed"].includes(d.status));
  const allDone = board.takenCount === board.totalCount;

  const notice = data.notice || data.error;
  const msg = board.messages[0];
  const refill = board.refills.find((r: Payload) => !r.ordered);

  mount(
    h(
      "main",
      { class: `today ${data.celebrate ? "celebrate" : ""}` },
      h(
        "header",
        { class: "top" },
        h("h1", { class: "greet" }, board.greeting),
        h("div", { class: "clock" }, h("span", { class: "time" }, board.nowLabel), h("span", { class: "day" }, board.weekday)),
      ),
      sunArc(board),
      notice ? h("p", { class: "notice", role: "status" }, notice) : null,
      h(
        "section",
        { class: "cols" },
        h(
          "div",
          { class: "col now" },
          h("h2", {}, allDone ? "All done for today" : open.length ? "Take now" : "Coming up"),
          allDone
            ? h("p", { class: "done" }, board.streakDays >= 2 ? `${board.streakDays} days in a row. Your family can see it.` : "Every dose is logged.")
            : open.length
              ? h("ul", { class: "doses" }, ...open.map((d: Payload) => doseRow(d, true)))
              : h("ul", { class: "doses" }, ...rest.filter((d: Payload) => d.status === "upcoming").slice(0, 1).map((d: Payload) => doseRow(d, false))),
        ),
        h(
          "div",
          { class: "col later" },
          h("h2", {}, "Rest of today"),
          h("ul", { class: "doses small" }, ...rest.map((d: Payload) => doseRow(d, false))),
          h(
            "div",
            { class: `checkin ${board.checkIn ? "yes" : "no"}` },
            board.checkIn ? `Check-in done: feeling ${board.checkIn.mood}` : `No check-in yet. Say "let's do my check-in".`,
          ),
        ),
      ),
      h(
        "footer",
        { class: "strip" },
        msg ? h("div", { class: "msg" }, h("strong", {}, `${msg.from}: `), msg.text, h("span", { class: "when" }, ` ${relTime(msg.at)}`)) : null,
        refill ? h("div", { class: "refill" }, `${refill.name} runs out in ${refill.daysLeft} days`) : null,
        board.clockAdjusted ? h("div", { class: "demo" }, "Demo clock") : null,
      ),
    ),
  );
}

connectView("today", render).then((a) => {
  app = a;
  // Stay live: family can send a note or a dose can be logged from another device.
  setInterval(async () => {
    if (busy || document.hidden) return;
    try {
      const r = await app.callServerTool({ name: "refresh_today", arguments: {} });
      render(r.structuredContent as Payload);
    } catch {}
  }, 15000);
});
