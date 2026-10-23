import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CareEngine, POLICY, SAFETY_LINE } from "./care.js";

const here = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = join(here, "..", "views", "dist");

export const ANNOUNCEMENTS_URI = "hearth://announcements";

export const UI = {
  today: "ui://hearth/today.html",
  checkin: "ui://hearth/checkin.html",
  refill: "ui://hearth/refill.html",
  family: "ui://hearth/family.html",
} as const;

export const SERVER_INSTRUCTIONS = `Hearth is a care circle for an older adult living alone (the "care recipient") and the family members who look after her from afar.

Voice style when talking to the care recipient: short, warm sentences; use her name; one question at a time; read numbers and times naturally ("eight in the morning"); never lecture.

Safety rules (non-negotiable):
- ${SAFETY_LINE}
- Never suggest taking an extra, doubled or make-up dose. If she isn't sure whether she took a dose, tell her not to take another one and offer to call the pharmacist.
- If she mentions chest pain, trouble breathing, a fall, or confusion, tell her to call 911 (or use Alexa emergency calling) right away. Do not wait to log anything first.
- Purchases (refills) always need an explicit "yes" after you read back the item, quantity, price and delivery. Use quote_refill first, then confirm_refill with the token only after that yes.

Typical flows:
- "I took my pills" → log_medication (medication: "morning pills" or the specific name).
- "Did I take my …?" / "I can't remember" → check_medication (never log_medication).
- "How am I doing today?" / "What's next?" → show_today.
- Morning → start_check_in, then record_check_in with her answers.
- Family member asks "How's Mom?" → get_care_summary or show_family_dashboard.
- A routine calls run_care_rounds every 15 minutes; it handles reminders, family escalation and refill forecasting idempotently.`;

function view(name: string): string {
  return readFileSync(join(VIEWS_DIR, `${name}.html`), "utf8");
}

const text = (t: string) => [{ type: "text" as const, text: t }];

export function buildServer(care: CareEngine): McpServer {
  const server = new McpServer(
    { name: "hearth", title: "Hearth: care circle", version: "1.0.0", websiteUrl: "https://github.com/" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {}, resources: { subscribe: true, listChanged: true } } },
  );

  // ------------------------------------------------------------------ UI resources (MCP Apps)
  const resources: [string, keyof typeof UI, string][] = [
    ["Hearth Today", "today", "Rosa's day at a glance: doses, check-in, messages from family."],
    ["Hearth Check-in", "checkin", "Three-tap morning check-in sized for a smart display."],
    ["Hearth Refill", "refill", "Refill purchase card with explicit confirmation."],
    ["Hearth Family Dashboard", "family", "7-day adherence, mood trend, alerts and refills for the family."],
  ];
  for (const [name, key, description] of resources) {
    registerAppResource(server, name, UI[key], { description, mimeType: RESOURCE_MIME_TYPE }, async () => ({
      contents: [{ uri: UI[key], mimeType: RESOURCE_MIME_TYPE, text: view(key), _meta: { ui: { prefersBorder: false } } }],
    }));
  }

  // ------------------------------------------------------------------ resources for model context
  server.registerResource(
    "care-plan",
    "hearth://care-plan",
    { title: "Care plan", description: "Medications, schedule, escalation policy, care team and family preferences.", mimeType: "text/markdown" },
    async (uri) => {
      const s = care.state;
      const md = [
        `# Care plan: ${care.recipient.name}`,
        `Home time zone: ${s.household.timeZone}`,
        `## Medications`,
        ...s.medications.map((m) => `- **${m.name} ${m.strength}** (${m.purpose}): ${m.instructions}. Scheduled ${m.times.join(", ")}. ${Math.floor(care.daysOfSupply(m))} days of supply, ${m.refillsLeft} refills left (${m.rxNumber}).`),
        `## Escalation ladder`,
        `- +${POLICY.reminderAfter} min: gentle reminder announced on her Echo`,
        `- +${POLICY.notifyPrimaryAfter} min: notify ${care.primary.name} (primary caregiver), respecting quiet hours unless urgent`,
        `- +${POLICY.notifyCircleAfter} min: notify the rest of the circle`,
        `- No check-in by ${POLICY.checkInReminderAt}: reminder; by ${POLICY.checkInNotifyAt}: notify ${care.primary.name}`,
        `## Care team`,
        `- Doctor: ${s.household.careTeam.doctor}, ${s.household.careTeam.doctorPhone}`,
        `- Pharmacy: ${s.household.careTeam.pharmacist}, ${s.household.careTeam.pharmacyPhone}`,
        `## Family circle`,
        ...s.people.map((p) => `- ${p.name} (${p.relationship}, ${p.role.replace("_", " ")}) via ${p.channel}`),
        `## Preferences`,
        ...s.preferences.map((p) => `- ${p.key}: ${p.value} (set by ${p.setBy})`),
      ].join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
    },
  );

  // ------------------------------------------------------------------ proactive announcements (resource subscription)
  // Devices in Rosa's home subscribe to hearth://announcements. When Hearth's care loop needs
  // to speak up (a late dose, a note from Daniel), the server sends notifications/resources/updated
  // and the device reads the resource and announces it, the way Alexa+ delivers proactive notifications.
  const subscriptions = new Set<string>();
  server.registerResource(
    "announcements",
    ANNOUNCEMENTS_URI,
    { title: "Announcements for the care recipient", description: "Things Hearth wants her devices to say out loud now (reminders, family messages). Subscribe to get notifications/resources/updated.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ announcements: care.announcements() }) }] }),
  );
  server.server.setRequestHandler("resources/subscribe", async (req: any) => {
    subscriptions.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", async (req: any) => {
    subscriptions.delete(req.params.uri);
    return {};
  });
  const onAnnouncement = () => {
    if (subscriptions.has(ANNOUNCEMENTS_URI)) server.server.sendResourceUpdated({ uri: ANNOUNCEMENTS_URI }).catch(() => {});
  };
  care.store.on("announcement", onAnnouncement);
  const prevClose = server.server.onclose;
  server.server.onclose = () => {
    care.store.off("announcement", onAnnouncement);
    prevClose?.();
  };

  // ------------------------------------------------------------------ tools: care recipient
  server.registerTool(
    "check_medication",
    {
      title: "Check medication",
      description: "Answer 'did I take my …?' without logging anything. Use this (not log_medication) whenever she is unsure. Returns what was logged today and safe wording.",
      inputSchema: z.object({ medication: z.string().describe("Medication name, purpose, or 'pills' for all") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ medication }) => {
      const r = care.checkMedication(medication);
      if (!r.ok) return { content: text(r.error), isError: true };
      return { content: text(`${r.answer} ${r.advice}`.trim()), structuredContent: r };
    },
  );

  registerAppTool(
    server,
    "show_today",
    {
      title: "Show today",
      description: "Show the care recipient's day on the smart display: each dose and whether it's taken, due, late or missed; today's check-in; unread family messages; refills running low. Use for 'what's next', 'did I take my pills', 'how's my day'.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UI.today } },
    },
    async () => {
      const board = care.todayBoard();
      const open = board.doses.filter((d) => ["due", "late", "missed"].includes(d.status));
      const say = [
        `${board.greeting}. It's ${board.nowLabel}.`,
        open.length ? `Still to take: ${open.map((d) => `${d.name} (${d.timeLabel}${d.status === "missed" ? ", missed" : d.status === "late" ? ", late" : ""})`).join(", ")}.` : board.takenCount === board.totalCount ? "All doses taken today. Well done!" : `Next: ${board.nextUp?.name} at ${board.nextUp?.timeLabel}.`,
        board.checkIn ? "" : "No check-in yet today.",
        board.messages.length ? `${board.messages.length} new message(s) from family.` : "",
        board.refills.filter((r) => !r.ordered).map((r) => `${r.name} runs out in ${r.daysLeft} days.`).join(" "),
      ].filter(Boolean).join(" ");
      return { content: text(say), structuredContent: { view: "today", board } };
    },
  );

  registerAppTool(
    server,
    "log_medication",
    {
      title: "Log medication",
      description: `Record that the care recipient took (or skipped) a dose. 'medication' can be a name ("metformin"), a purpose ("blood pressure pill"), or a group ("morning pills", "all"). Refuses to log a dose that was already taken (double-dose guard) and explains why. ${SAFETY_LINE}`,
      inputSchema: z.object({
        medication: z.string().describe('Medication name, purpose, or group such as "morning pills"'),
        status: z.enum(["taken", "skipped"]).default("taken"),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Scheduled slot HH:MM, only if ambiguous"),
        note: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UI.today } },
    },
    async ({ medication, status, time, note }) => {
      const r = await care.logDose({ medication, status, time, note });
      const board = care.todayBoard();
      if (!r.ok) return { content: text(r.error), structuredContent: { view: "today", board, error: r.error }, isError: true };
      if (r.logged.length === 0) return { content: text(r.message!), structuredContent: { view: "today", board, notice: r.message } };
      const names = r.logged.map((l) => l.name).join(" and ");
      const say = [
        status === "taken" ? `Got it, ${care.recipient.name}. ${names} logged.` : `Okay, I noted that you skipped ${names}.`,
        r.remainingToday?.length ? `Next: ${r.remainingToday[0]}.` : "That's everything for today.",
        r.familyUpdated?.length ? `I let ${r.familyUpdated.join(" and ")} know, so they won't worry.` : "",
        (r.streakDays ?? 0) >= 3 ? `That's a ${r.streakDays}-day streak.` : "",
      ].filter(Boolean).join(" ");
      return { content: text(say), structuredContent: { view: "today", board, celebrate: status === "taken", logged: r.logged, familyUpdated: r.familyUpdated } };
    },
  );

  registerAppTool(
    server,
    "start_check_in",
    {
      title: "Start daily check-in",
      description: "Open the morning check-in on the display: mood, sleep, pain (three big buttons each). She can tap or answer by voice; then call record_check_in.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UI.checkin } },
    },
    async () => {
      const existing = care.todayBoard().checkIn;
      return {
        content: text(existing ? `You already checked in today (mood ${existing.mood}). Want to update it? How are you feeling?` : `Let's do your check-in, ${care.recipient.name}. First: how are you feeling today? Great, okay, or low?`),
        structuredContent: { view: "checkin", person: care.recipient.name, existing },
      };
    },
  );

  registerAppTool(
    server,
    "record_check_in",
    {
      title: "Record check-in",
      description: "Save today's check-in. If she reports a lot of pain, or feeling low two days running, Hearth gently flags it to the primary caregiver (no diagnosis, just 'a call might help').",
      inputSchema: z.object({
        mood: z.enum(["great", "okay", "low"]),
        sleep: z.enum(["well", "so-so", "poorly"]),
        pain: z.enum(["none", "some", "a lot"]),
        note: z.string().max(300).optional().describe("Anything she wants the family to know, in her words"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UI.today, visibility: ["model", "app"] } },
    },
    async (args) => {
      const r = await care.recordCheckIn(args);
      const say = [
        `Thanks, ${care.recipient.name}. Check-in saved.`,
        args.mood === "low" ? "I'm sorry you're feeling low." : args.mood === "great" ? "Love to hear it." : "",
        r.familyNotified.length ? `I let ${r.familyNotified.join(" and ")} know so they can give you a call.` : "",
        args.pain === "a lot" ? `If the pain gets worse or it's sudden, please call ${care.state.household.careTeam.doctor} or 911.` : "",
      ].filter(Boolean).join(" ");
      return { content: text(say), structuredContent: { view: "today", board: care.todayBoard(), checkIn: r.checkIn, familyNotified: r.familyNotified } };
    },
  );

  server.registerTool(
    "send_family_message",
    {
      title: "Send family message",
      description: "Send a short message between the care recipient and someone in the family circle (e.g. 'tell Daniel I loved the photos'). Messages to family arrive as a push/SMS; messages to her appear on her Echo Show.",
      inputSchema: z.object({
        to: z.string().describe("Name or relationship, e.g. 'Daniel', 'Ana', 'Mom'"),
        text: z.string().min(1).max(500),
        from: z.string().default("rosa").describe("Sender; defaults to the care recipient"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, text: body, from }) => {
      const r = await care.sendMessage({ from, to, text: body });
      if (!r.ok) return { content: text(r.error), isError: true };
      return { content: text(`Sent to ${r.message.to}: "${r.message.text}"`), structuredContent: { message: r.message } };
    },
  );

  server.registerTool(
    "read_family_messages",
    {
      title: "Read family messages",
      description: "Read unread messages from family to the care recipient aloud, and mark them read.",
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const msgs = care.todayBoard().messages;
      care.markMessagesRead();
      return {
        content: text(msgs.length ? msgs.map((m) => `From ${m.from}: ${m.text}`).join("\n") : "No new messages."),
        structuredContent: { messages: msgs },
      };
    },
  );

  // ------------------------------------------------------------------ tools: agentic care loop
  server.registerTool(
    "run_care_rounds",
    {
      title: "Run care rounds",
      description: `Hearth's autonomous care loop. Checks every dose and the daily check-in against the escalation ladder (reminder at +${POLICY.reminderAfter} min, primary caregiver at +${POLICY.notifyPrimaryAfter}, whole circle at +${POLICY.notifyCircleAfter}), forecasts refills and prepares a quote, and respects each family member's quiet hours. Idempotent: safe to call every 15 minutes from a routine.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const r = await care.runCareRounds();
      return { content: text(r.summary), structuredContent: r };
    },
  );

  // ------------------------------------------------------------------ tools: purchasing
  registerAppTool(
    server,
    "quote_refill",
    {
      title: "Quote a refill",
      description: "Get a price and delivery quote for a prescription refill and show a confirmation card. Does NOT place the order. Read the quote back and ask for an explicit yes before calling confirm_refill.",
      inputSchema: z.object({ medication: z.string().describe("Medication name or purpose") }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: UI.refill } },
    },
    async ({ medication }) => {
      const r = await care.quoteRefill({ medication });
      if (!r.ok) return { content: text(r.error), isError: true, structuredContent: { view: "refill", error: r.error } };
      return {
        content: text(`${r.confirmPrompt} Say yes to order. (quote token: ${r.quote.token})`),
        structuredContent: { view: "refill", ...r },
      };
    },
  );

  registerAppTool(
    server,
    "confirm_refill",
    {
      title: "Confirm refill order",
      description: "Place a refill order from a quote. Only call after the person explicitly said yes to the read-back of item, quantity, price and delivery. Requires the quote token from quote_refill; tokens expire after 15 minutes.",
      inputSchema: z.object({
        token: z.string().describe("Token from quote_refill"),
        confirmedBy: z.string().default("rosa").describe("Who said yes (name)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: UI.refill } },
    },
    async ({ token, confirmedBy }) => {
      const r = await care.confirmRefill({ token, confirmedBy });
      if (!r.ok) return { content: text(r.error), isError: true, structuredContent: { view: "refill", error: r.error } };
      return {
        content: text(`Done. ${r.order.medication} is ordered (${r.order.id}), $${r.order.copay.toFixed(2)}, arriving ${r.order.arrives}.${r.sandbox ? " (sandbox pharmacy)" : ""}`),
        structuredContent: { view: "refill", confirmed: true, ...r },
      };
    },
  );

  // ------------------------------------------------------------------ tools: family
  registerAppTool(
    server,
    "show_family_dashboard",
    {
      title: "Show family dashboard",
      description: "For family caregivers: 7-day medication adherence, mood/sleep/pain trend, alerts sent, refill status and recent activity, with one-tap actions (confirm refill, send a note).",
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: UI.family } },
    },
    async () => {
      const w = care.weekly();
      return { content: text(care.summaryText()), structuredContent: { view: "family", ...w } };
    },
  );

  server.registerTool(
    "get_care_summary",
    {
      title: "Get care summary",
      description: "Plain-language summary for a family member asking 'how's Mom doing?': adherence, missed doses, today's status, check-ins, mood trend, low supplies.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({ content: text(care.summaryText()) }),
  );

  // ------------------------------------------------------------------ app-only tools (views refresh themselves)
  registerAppTool(
    server,
    "refresh_today",
    {
      title: "Refresh today (view)",
      description: "Used by the Today view to refresh itself. Not for the model.",
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI.today, visibility: ["app"] } },
    },
    async () => ({ content: text("refreshed"), structuredContent: { view: "today", board: care.todayBoard() } }),
  );

  registerAppTool(
    server,
    "refresh_family",
    {
      title: "Refresh family dashboard (view)",
      description: "Used by the family dashboard view to refresh itself. Not for the model.",
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI.family, visibility: ["app"] } },
    },
    async () => ({ content: text("refreshed"), structuredContent: { view: "family", ...care.weekly() } }),
  );

  // ------------------------------------------------------------------ prompts
  server.registerPrompt(
    "morning_routine",
    { title: "Morning routine", description: "Walk the care recipient through her morning: today's board, check-in, morning pills, family messages." },
    async () => ({
      messages: [{ role: "user", content: { type: "text", text: "Run my morning routine: show today, do my check-in, help me log my morning pills, and read me any messages from family. Keep it short and warm." } }],
    }),
  );
  server.registerPrompt(
    "caregiver_briefing",
    { title: "Caregiver briefing", description: "Weekly briefing for a family caregiver." },
    async () => ({
      messages: [{ role: "user", content: { type: "text", text: "Give me this week's briefing on Mom: show the family dashboard, call out anything I should act on (refills, missed doses, pain or low mood), and suggest one kind thing I could do this week." } }],
    }),
  );

  return server;
}
