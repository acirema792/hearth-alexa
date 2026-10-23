import { torndown, connectView, h, mount, relTime, type Payload } from "./shared";

let app: Awaited<ReturnType<typeof connectView>>;
let last: Payload | null = null;
let draft = "";

const MOOD_WORD: Record<string, string> = { great: "great", okay: "okay", low: "low" };

function grid(w: Payload) {
  // Rows: each scheduled slot ("Metformin 8:00 AM"); columns: last 7 days.
  const slots: string[] = [];
  for (const d of w.days) for (const x of d.doses) {
    const k = `${x.name}|${x.time}`;
    if (!slots.includes(k)) slots.push(k);
  }
  const head = h("tr", {}, h("th", {}, ""), ...w.days.map((d: Payload) => h("th", { class: d.isToday ? "today" : "" }, d.isToday ? "Today" : d.weekday)));
  const rows = slots.map((k) => {
    const [name, time] = k.split("|");
    return h(
      "tr",
      {},
      h("th", { scope: "row" }, h("span", { class: "rname" }, name), h("span", { class: "rtime" }, time)),
      ...w.days.map((d: Payload) => {
        const x = d.doses.find((y: Payload) => y.name === name && y.time === time);
        const st = x?.status ?? "none";
        const title = st === "taken" ? (x.minutesLate > 45 ? `taken ${x.minutesLate} min late` : "taken") : st;
        return h("td", {}, h("span", { class: `cell ${st} ${st === "taken" && x.minutesLate > 45 ? "tardy" : ""}`, title, "aria-label": `${d.weekday} ${name} ${time}: ${title}` }));
      }),
    );
  });
  const mood = h("tr", { class: "mood" }, h("th", { scope: "row" }, "Mood"), ...w.days.map((d: Payload) => h("td", { class: `m ${d.mood ?? "none"}` }, d.mood ? MOOD_WORD[d.mood] : "–")));
  const pain = h("tr", { class: "pain" }, h("th", { scope: "row" }, "Pain"), ...w.days.map((d: Payload) => h("td", { class: `p ${(d.pain ?? "none").replace(" ", "")}`, title: d.note ?? "" }, d.pain ?? "–")));
  return h("table", { class: "week" }, h("thead", {}, head), h("tbody", {}, ...rows, mood, pain));
}

async function confirm(q: Payload, btn: HTMLButtonElement) {
  btn.disabled = true;
  btn.textContent = "Ordering…";
  const r = await app.callServerTool({ name: "confirm_refill", arguments: { token: q.token, confirmedBy: w().viewer } });
  const d = r.structuredContent as Payload;
  await app.updateModelContext({ content: [{ type: "text", text: d.confirmed ? `${w().viewer} confirmed the ${q.name} refill (${d.order.id}) from the dashboard.` : `Refill confirm failed: ${d.error}` }] }).catch(() => {});
  await refresh();
}

async function sendNote(input: HTMLInputElement, btn: HTMLButtonElement) {
  const text = input.value.trim();
  if (!text) return input.focus();
  btn.disabled = true;
  await app.callServerTool({ name: "send_family_message", arguments: { from: w().viewer, to: w().person, text } });
  draft = "";
  await app.updateModelContext({ content: [{ type: "text", text: `${w().viewer} sent ${w().person} a note from the dashboard: "${text}"` }] }).catch(() => {});
  await refresh();
}

const w = () => last as Payload;

async function refresh() {
  const r = await app.callServerTool({ name: "refresh_family", arguments: {} });
  render(r.structuredContent as Payload);
}

function render(data: Payload) {
  if (data.view !== "family") return;
  last = data;
  const needs: Node[] = [];
  for (const q of data.openQuotes) {
    const b = h("button", { type: "button", class: "primary" }, `Confirm $${q.copay.toFixed(2)}`) as HTMLButtonElement;
    b.onclick = () => confirm(q, b);
    needs.push(h("li", { class: "need refill" }, h("div", {}, h("strong", {}, `${q.name} refill ready`), h("span", {}, `${q.quantity} tablets · ${q.delivery}`)), b));
  }
  for (const m of data.medications.filter((m: Payload) => m.lowSupply && !data.openQuotes.some((q: Payload) => q.medId === m.id) && !data.orders.some((o: Payload) => o.medId === m.id && o.status !== "delivered"))) {
    needs.push(h("li", { class: "need" }, h("div", {}, h("strong", {}, `${m.name}: ${m.daysLeft} days left`), h("span", {}, "Ask Hearth to quote a refill"))));
  }
  for (const o of data.orders.filter((o: Payload) => o.status !== "delivered")) {
    needs.push(h("li", { class: "need ok" }, h("div", {}, h("strong", {}, `${o.name} refill ordered`), h("span", {}, `${o.id} · confirmed by ${o.confirmedBy}`))));
  }

  const input = h("input", { type: "text", placeholder: `A note for ${data.person}'s Echo Show`, maxlength: 200, "aria-label": `Note for ${data.person}` }) as HTMLInputElement;
  input.value = draft;
  input.oninput = () => (draft = input.value);
  const send = h("button", { type: "button", class: "primary" }, "Send") as HTMLButtonElement;
  send.onclick = () => sendNote(input, send);
  input.onkeydown = (e) => e.key === "Enter" && sendNote(input, send);

  mount(
    h(
      "main",
      { class: "family" },
      h(
        "header",
        {},
        h("h1", {}, `${data.person}'s week`),
        h("p", { class: "score" }, h("span", { class: "pct" }, `${data.adherencePct}%`), ` of doses taken`, data.streakDays ? `, ${data.streakDays}-day streak` : ""),
      ),
      grid(data),
      h("p", { class: "legend" }, h("span", { class: "cell taken" }), " taken ", h("span", { class: "cell taken tardy" }), " taken late ", h("span", { class: "cell missed" }), " missed ", h("span", { class: "cell upcoming" }), " later today"),
      needs.length ? h("section", {}, h("h2", {}, "Needs you"), h("ul", { class: "needs" }, ...needs)) : null,
      h("section", { class: "note" }, h("h2", {}, `Send ${data.person} a note`), h("div", { class: "row" }, input, send)),
      h(
        "section",
        {},
        h("h2", {}, "What Hearth did"),
        h(
          "ul",
          { class: "alerts" },
          ...(data.alerts.length
            ? data.alerts.slice(0, 6).map((a: Payload) => h("li", { class: a.severity }, h("div", { class: "a-title" }, a.title, h("span", { class: "a-when" }, ` → ${a.to}, ${relTime(a.at)}${a.delivered === "held_quiet_hours" ? ", held for quiet hours" : ""}`)), h("div", { class: "a-body" }, a.body)))
            : [h("li", {}, "No alerts this week. Quiet is good.")]),
        ),
      ),
    ),
  );
}

document.documentElement.dataset.theme = "light";
connectView("family", render).then((a) => {
  app = a;
  setInterval(() => !document.hidden && !torndown && document.activeElement?.tagName !== "INPUT" && refresh().catch(() => {}), 5000);
});
