import { connectView, h, mount, type Payload } from "./shared";

let app: Awaited<ReturnType<typeof connectView>>;
let current: Payload | null = null;
let timer: number | undefined;

function money(n: number) {
  return `$${Number(n).toFixed(2)}`;
}

function render(data: Payload) {
  clearInterval(timer);
  if (data.error) {
    mount(h("main", { class: "refill" }, h("h1", {}, "Can't order that refill"), h("p", { class: "err" }, data.error)));
    return;
  }
  if (data.confirmed) {
    const o = data.order;
    mount(
      h(
        "main",
        { class: "refill ordered" },
        h("div", { class: "stamp", "aria-hidden": "true" }, "✓"),
        h("h1", {}, `${o.medication} is on its way`),
        h("dl", {}, h("dt", {}, "Arrives"), h("dd", {}, o.arrives), h("dt", {}, "Copay"), h("dd", {}, money(o.copay)), h("dt", {}, "Order"), h("dd", {}, o.id)),
        data.sandbox ? h("p", { class: "sandbox" }, "Sandbox pharmacy. No real order was placed.") : null,
      ),
    );
    return;
  }
  current = data;
  const q = data.quote, m = data.medication;
  // Count down the quote's TTL from now (server time may be a demo clock).
  const expires = Date.now() + (new Date(q.expiresAt).getTime() - new Date(q.createdAt).getTime());
  const left = h("span", { class: "left" });
  const tick = () => {
    const s = Math.max(0, Math.round((expires - Date.now()) / 1000));
    left.textContent = s > 0 ? `Price held for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "Quote expired. Ask for a new one.";
  };
  tick();
  timer = window.setInterval(tick, 1000);

  const order = h("button", { type: "button", class: "go" }, `Order for ${money(q.copay)}`) as HTMLButtonElement;
  order.onclick = async () => {
    order.disabled = true;
    order.textContent = "Ordering…";
    const r = await app.callServerTool({ name: "confirm_refill", arguments: { token: q.token, confirmedBy: "rosa" } });
    const d = r.structuredContent as Payload;
    render(d);
    await app.updateModelContext({ content: [{ type: "text", text: d.confirmed ? `Rosa tapped "Order" on the display. Refill ${d.order.id} placed, arriving ${d.order.arrives}.` : `Refill order failed: ${d.error}` }] }).catch(() => {});
  };
  const later = h("button", { type: "button", class: "later" }, "Not now");
  later.onclick = () => {
    mount(h("main", { class: "refill" }, h("h1", {}, "Okay, not now."), h("p", {}, `I'll remind you while there are still ${m.daysLeft} days left.`)));
    app.updateModelContext({ content: [{ type: "text", text: "Rosa declined the refill for now on the display." }] }).catch(() => {});
  };

  mount(
    h(
      "main",
      { class: "refill" },
      h("p", { class: "why" }, `${m.name} runs out in ${m.daysLeft} days`),
      h("h1", {}, `Refill ${m.name} ${m.strength}?`),
      h(
        "dl",
        {},
        h("dt", {}, "Quantity"), h("dd", {}, `${q.quantity} tablets`),
        h("dt", {}, "Copay"), h("dd", {}, money(q.copay)),
        h("dt", {}, "Delivery"), h("dd", {}, q.delivery),
        h("dt", {}, "Pharmacy"), h("dd", {}, q.pharmacy),
        h("dt", {}, "Prescription"), h("dd", {}, `${m.rxNumber} · ${m.refillsLeft} refills left`),
      ),
      h("div", { class: "actions" }, order, later),
      left,
    ),
  );
}

connectView("refill", render).then((a) => (app = a));
void current;
