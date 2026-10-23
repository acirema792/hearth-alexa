import { connectView, h, mount, type Payload } from "./shared";

let app: Awaited<ReturnType<typeof connectView>>;
const QUESTIONS = [
  { key: "mood", ask: "How are you feeling today?", options: [["great", "Great"], ["okay", "Okay"], ["low", "Low"]] },
  { key: "sleep", ask: "How did you sleep?", options: [["well", "Well"], ["so-so", "So-so"], ["poorly", "Poorly"]] },
  { key: "pain", ask: "Any pain today?", options: [["none", "None"], ["some", "Some"], ["a lot", "A lot"]] },
] as const;

let answers: Record<string, string> = {};
let step = 0;
let person = "Rosa";

function render() {
  if (step >= QUESTIONS.length) return submit();
  const q = QUESTIONS[step];
  mount(
    h(
      "main",
      { class: "checkin" },
      h("div", { class: "progress", "aria-label": `Question ${step + 1} of ${QUESTIONS.length}` }, ...QUESTIONS.map((_, i) => h("span", { class: i < step ? "done" : i === step ? "on" : "" }))),
      h("h1", {}, step === 0 ? `Good to see you, ${person}. ${q.ask}` : q.ask),
      h(
        "div",
        { class: "choices" },
        ...q.options.map(([value, label], i) =>
          h("button", { type: "button", class: `choice c${i}`, onclick: () => { answers[q.key] = value; step++; render(); } }, label),
        ),
      ),
      h("p", { class: "hint" }, "Tap an answer, or just say it."),
    ),
  );
}

async function submit() {
  mount(h("main", { class: "checkin" }, h("h1", {}, "Saving your check-in…")));
  const r = await app.callServerTool({ name: "record_check_in", arguments: answers });
  const data = r.structuredContent as Payload;
  const told = (data?.familyNotified ?? []) as string[];
  await app.updateModelContext({ content: [{ type: "text", text: `Rosa completed her check-in on the display: mood ${answers.mood}, sleep ${answers.sleep}, pain ${answers.pain}.${told.length ? ` Hearth notified ${told.join(", ")}.` : ""}` }] }).catch(() => {});
  mount(
    h(
      "main",
      { class: "checkin thanks" },
      h("h1", {}, `Thank you, ${person}.`),
      h("p", { class: "big" }, answers.mood === "low" ? "I'm sorry today's a low one." : answers.mood === "great" ? "Love to hear it." : "Noted for today."),
      told.length ? h("p", { class: "told" }, `${told.join(" and ")} will give you a call.`) : null,
    ),
  );
}

connectView("checkin", (data) => {
  person = data.person ?? person;
  if (data.view === "checkin") {
    answers = {};
    step = 0;
    render();
  }
}).then((a) => (app = a));
