import { randomUUID } from "node:crypto";
import { addDays, Clock, formatTime, hhmmToLabel, localInstant, zonedParts } from "./clock.js";
import type { CheckIn, DoseLog, HearthState, Medication, Mood, Notification, Pain, Person, Sleep } from "./model.js";
import type { Notifier, Pharmacy } from "./services.js";
import type { Store } from "./store.js";

export type LiveDoseStatus = "taken" | "skipped" | "upcoming" | "due" | "late" | "missed";

export interface DoseView {
  id: string;
  medId: string;
  name: string;
  strength: string;
  purpose: string;
  instructions: string;
  time: string;
  timeLabel: string;
  status: LiveDoseStatus;
  minutesLate: number;
  loggedAt?: string;
  loggedAtLabel?: string;
}

/** Timing policy, in minutes relative to the scheduled time. */
export const POLICY = {
  dueWindowBefore: 30,
  lateAfter: 30,
  missedAfter: 120,
  reminderAfter: 30,
  notifyPrimaryAfter: 60,
  notifyCircleAfter: 120,
  checkInReminderAt: "11:00",
  checkInNotifyAt: "13:00",
  quoteTtlMinutes: 15,
  doubleDoseGuardHours: 4,
};

export const SAFETY_LINE =
  "Hearth can't give medical or dosing advice. For questions about a dose, call the pharmacist or doctor.";

export class CareEngine {
  constructor(
    private readonly store: Store,
    readonly clock: Clock,
    private readonly notifier: Notifier,
    private readonly pharmacy: Pharmacy,
  ) {}

  get state(): HearthState {
    return this.store.get();
  }
  get tz(): string {
    return this.state.household.timeZone;
  }
  person(id: string): Person {
    const p = this.state.people.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown person "${id}"`);
    return p;
  }
  get recipient(): Person {
    return this.person(this.state.household.careRecipientId);
  }
  get primary(): Person {
    return this.state.people.find((p) => p.role === "primary_caregiver")!;
  }

  // ------------------------------------------------------------------ reading

  today(now = this.clock.now()): string {
    return zonedParts(now, this.tz).date;
  }

  doseStatus(med: Medication, date: string, time: string, now: Date): { status: LiveDoseStatus; minutesLate: number; log?: DoseLog } {
    const id = `${date}:${med.id}:${time}`;
    const log = this.state.doses.find((d) => d.id === id);
    const scheduled = localInstant(this.tz, date, time).getTime();
    const minutesLate = Math.floor((now.getTime() - scheduled) / 60_000);
    if (log) return { status: log.status, minutesLate, log };
    if (minutesLate < -POLICY.dueWindowBefore) return { status: "upcoming", minutesLate };
    if (minutesLate < POLICY.lateAfter) return { status: "due", minutesLate };
    if (minutesLate < POLICY.missedAfter) return { status: "late", minutesLate };
    return { status: "missed", minutesLate };
  }

  dosesFor(date: string, now = this.clock.now()): DoseView[] {
    const out: DoseView[] = [];
    for (const med of this.state.medications) {
      for (const time of med.times) {
        const s = this.doseStatus(med, date, time, now);
        out.push({
          id: `${date}:${med.id}:${time}`,
          medId: med.id,
          name: med.name,
          strength: med.strength,
          purpose: med.purpose,
          instructions: med.instructions,
          time,
          timeLabel: hhmmToLabel(time),
          status: s.status,
          minutesLate: Math.max(0, s.minutesLate),
          loggedAt: s.log?.at,
          loggedAtLabel: s.log ? formatTime(new Date(s.log.at), this.tz) : undefined,
        });
      }
    }
    return out.sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
  }

  daysOfSupply(med: Medication): number {
    return med.pillsRemaining / (med.pillsPerDose * med.times.length);
  }

  /** Everything the Echo Show "Today" card needs, in one structured payload. */
  todayBoard(now = this.clock.now()) {
    const date = this.today(now);
    const p = zonedParts(now, this.tz);
    const doses = this.dosesFor(date, now);
    const checkIn = this.state.checkIns.find((c) => c.date === date);
    const unread = this.state.messages.filter((m) => m.to === this.recipient.id && !m.readAt);
    const announcements = this.state.notifications
      .filter((n) => n.to === this.recipient.id && n.at.slice(0, 10) >= addDays(date, -1))
      .slice(-3);
    const greeting = p.hour < 12 ? "Good morning" : p.hour < 17 ? "Good afternoon" : "Good evening";
    const nextUp = doses.find((d) => d.status === "due" || d.status === "late") ?? doses.find((d) => d.status === "upcoming");
    const refills = this.state.medications
      .filter((m) => this.daysOfSupply(m) <= m.refillThresholdDays)
      .map((m) => ({
        medId: m.id,
        name: m.name,
        daysLeft: Math.floor(this.daysOfSupply(m)),
        ordered: this.state.orders.some((o) => o.medId === m.id && o.status !== "delivered"),
      }));
    return {
      household: this.state.household.name,
      person: this.recipient.name,
      date,
      weekday: p.weekday,
      nowLabel: formatTime(now, this.tz),
      greeting: `${greeting}, ${this.recipient.name}`,
      doses,
      takenCount: doses.filter((d) => d.status === "taken").length,
      totalCount: doses.length,
      nextUp: nextUp ? { id: nextUp.id, name: nextUp.name, timeLabel: nextUp.timeLabel, status: nextUp.status } : null,
      checkIn: checkIn ?? null,
      messages: unread.map((m) => ({ id: m.id, from: this.person(m.from).name, relationship: this.person(m.from).relationship, text: m.text, at: m.at })),
      announcements: announcements.map((a) => ({ title: a.title, body: a.body, at: a.at })),
      refills,
      streakDays: this.streak(now),
      clockAdjusted: this.clock.isAdjusted(),
    };
  }

  /** Consecutive fully-adherent days ending yesterday (plus today if already complete). */
  streak(now = this.clock.now()): number {
    const today = this.today(now);
    let n = 0;
    const todayDoses = this.dosesFor(today, now);
    if (todayDoses.every((d) => d.status === "taken")) n++;
    for (let back = 1; back <= 60; back++) {
      const date = addDays(today, -back);
      const ds = this.dosesFor(date, now);
      if (!this.state.doses.some((d) => d.date === date)) break;
      if (ds.every((d) => d.status === "taken")) n++;
      else break;
    }
    return n;
  }

  // ------------------------------------------------------------------ dose logging

  resolveMed(query: string): Medication | undefined {
    const q = query.trim().toLowerCase();
    return this.state.medications.find(
      (m) => m.id === q || m.name.toLowerCase() === q || q.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(q) || q.includes(m.purpose),
    );
  }

  /**
   * Log one or more doses. `medication` may be a name, a purpose ("blood pressure pill"),
   * or "all due" to log everything currently due or late (what people actually say:
   * "I took my morning pills").
   */
  async logDose(input: { medication: string; status?: "taken" | "skipped"; time?: string; by?: string; note?: string }) {
    const now = this.clock.now();
    const date = this.today(now);
    const status = input.status ?? "taken";
    const by = input.by ?? this.recipient.id;
    const all = /\b(all|every|morning|evening|night|bedtime|my pills|my meds|medicines|them)\b/i.test(input.medication) && !this.resolveMed(input.medication);
    const candidates = this.dosesFor(date, now).filter((d) => {
      if (all) {
        const period = /morning/i.test(input.medication) ? (t: string) => t < "12:00" : /evening|night|bedtime/i.test(input.medication) ? (t: string) => t >= "17:00" : () => true;
        return period(d.time) && ["due", "late", "missed"].includes(d.status);
      }
      const med = this.resolveMed(input.medication);
      return med?.id === d.medId;
    });

    if (!all && candidates.length === 0) {
      return {
        ok: false as const,
        error: `I couldn't find a medication called "${input.medication}". Rosa's list: ${this.state.medications.map((m) => `${m.name} (${m.purpose})`).join(", ")}.`,
      };
    }

    let targets = candidates;
    if (!all) {
      // Pick the explicitly requested slot, else the most relevant open slot.
      if (input.time) targets = candidates.filter((d) => d.time === input.time);
      else {
        const open = candidates.filter((d) => ["due", "late", "missed"].includes(d.status));
        targets = open.length ? [open[0]] : [];
      }
    }

    if (targets.length === 0) {
      // Double-dose guard: refuse to log a dose that was already taken recently, and say why.
      const med = all ? undefined : this.resolveMed(input.medication);
      const recent = this.state.doses
        .filter((d) => (!med || d.medId === med.id) && d.status === "taken")
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      const upcoming = candidates.find((d) => d.status === "upcoming");
      const recentLabel = recent ? `${this.medName(recent.medId)} was already logged at ${formatTime(new Date(recent.at), this.tz)}` : "Nothing is due right now";
      return {
        ok: true as const,
        logged: [],
        alreadyTaken: true,
        message: `${recentLabel}${upcoming ? `; the next one is at ${upcoming.timeLabel}` : ""}. If you're unsure whether you took a dose, please don't take another one. ${SAFETY_LINE}`,
        careTeam: this.state.household.careTeam,
      };
    }

    const logged: { id: string; name: string; time: string; minutesLate: number }[] = [];
    const resolvedEscalations: string[] = [];
    this.store.mutate("dose_logged", (s) => {
      for (const t of targets) {
        if (s.doses.some((d) => d.id === t.id)) continue;
        s.doses.push({ id: t.id, medId: t.medId, date, time: t.time, status, at: now.toISOString(), by, note: input.note });
        const med = s.medications.find((m) => m.id === t.medId)!;
        if (status === "taken") med.pillsRemaining = Math.max(0, med.pillsRemaining - med.pillsPerDose);
        logged.push({ id: t.id, name: t.name, time: t.time, minutesLate: t.minutesLate });
        if (s.escalations.some((e) => e.doseId === t.id && e.step !== "reminder")) resolvedEscalations.push(t.id);
        s.activity.push({ at: now.toISOString(), actor: by, text: `${status === "taken" ? "Took" : "Skipped"} ${t.name} (${t.timeLabel})` });
      }
    });

    // Close the loop with anyone we worried: "she took it, you can relax."
    const notified: Notification[] = [];
    for (const doseId of resolvedEscalations) {
      const d = logged.find((l) => l.id === doseId)!;
      const peopleWorried = new Set(this.state.notifications.filter((n) => n.reason.includes(doseId) && n.to !== this.recipient.id).map((n) => n.to));
      for (const pid of peopleWorried) {
        notified.push(
          await this.notify(pid, {
            severity: "info",
            title: `✅ ${this.recipient.name} took ${d.name}`,
            body: `Logged at ${formatTime(now, this.tz)} (${d.minutesLate} min after the ${hhmmToLabel(d.time)} dose). No action needed.`,
            reason: `resolved:${doseId}`,
          }),
        );
      }
    }

    const board = this.todayBoard(now);
    return {
      ok: true as const,
      logged,
      status,
      remainingToday: board.doses.filter((d) => !["taken", "skipped"].includes(d.status)).map((d) => `${d.name} at ${d.timeLabel}`),
      streakDays: board.streakDays,
      familyUpdated: notified.map((n) => this.person(n.to).name),
    };
  }

  medName(id: string): string {
    return this.state.medications.find((m) => m.id === id)?.name ?? id;
  }

  // ------------------------------------------------------------------ check-ins

  async recordCheckIn(input: { mood: Mood; sleep: Sleep; pain: Pain; note?: string }) {
    const now = this.clock.now();
    const date = this.today(now);
    const entry: CheckIn = { date, at: now.toISOString(), ...input };
    this.store.mutate("checkin", (s) => {
      s.checkIns = s.checkIns.filter((c) => c.date !== date);
      s.checkIns.push(entry);
      s.activity.push({ at: entry.at, actor: this.recipient.id, text: `Check-in: mood ${input.mood}, sleep ${input.sleep}, pain ${input.pain}` });
    });

    const flags: string[] = [];
    const yesterday = this.state.checkIns.find((c) => c.date === addDays(date, -1));
    if (input.pain === "a lot") flags.push("pain");
    if (input.mood === "low" && yesterday?.mood === "low") flags.push("low_mood_2_days");
    const notified: string[] = [];
    if (flags.length) {
      const what = flags.includes("pain")
        ? `reported a lot of pain this morning${input.note ? ` ("${input.note}")` : ""}`
        : "has said she's feeling low two days in a row";
      const n = await this.notify(this.primary.id, {
        severity: "attention",
        title: `💛 Check in on ${this.recipient.name}`,
        body: `${this.recipient.name} ${what}. A call from you might help. If it's medical, ${this.state.household.careTeam.doctor}: ${this.state.household.careTeam.doctorPhone}.`,
        reason: `checkin:${date}:${flags.join(",")}`,
      });
      notified.push(this.person(n.to).name);
    }
    return { ok: true as const, checkIn: entry, flags, familyNotified: notified };
  }

  // ------------------------------------------------------------------ family messages

  async sendMessage(input: { from: string; to: string; text: string }) {
    const now = this.clock.now();
    const to = this.findPerson(input.to);
    const from = this.findPerson(input.from);
    if (!to || !from) return { ok: false as const, error: `Unknown person. Circle: ${this.state.people.map((p) => `${p.name} (${p.relationship})`).join(", ")}` };
    const msg = { id: randomUUID(), from: from.id, to: to.id, text: input.text.slice(0, 500), at: now.toISOString() };
    this.store.mutate("message", (s) => {
      s.messages.push(msg);
      s.activity.push({ at: msg.at, actor: from.id, text: `Message to ${to.name}` });
    });
    if (to.id !== this.recipient.id) {
      await this.notify(to.id, { severity: "info", title: `💬 ${from.name}`, body: msg.text, reason: `message:${msg.id}` });
    }
    return { ok: true as const, message: { ...msg, from: from.name, to: to.name } };
  }

  markMessagesRead() {
    const now = this.clock.now().toISOString();
    let n = 0;
    this.store.mutate("messages_read", (s) => {
      for (const m of s.messages) if (m.to === this.recipient.id && !m.readAt) {
        m.readAt = now;
        n++;
      }
    });
    return n;
  }

  findPerson(q: string): Person | undefined {
    const s = q.trim().toLowerCase();
    return this.state.people.find((p) => p.id === s || p.name.toLowerCase() === s || p.relationship.toLowerCase() === s || (s === "mom" && p.role === "care_recipient") || s.includes(p.name.toLowerCase()));
  }

  // ------------------------------------------------------------------ notifications

  async notify(personId: string, n: { severity: Notification["severity"]; title: string; body: string; reason: string }) {
    const now = this.clock.now();
    const note = await this.notifier.send(this.person(personId), n, now);
    this.store.mutate("notification", (s) => {
      s.notifications.push(note);
      s.activity.push({ at: note.at, actor: "hearth", text: `Notified ${this.person(personId).name}: ${n.title}` });
    });
    return note;
  }

  // ------------------------------------------------------------------ care rounds (the agent loop)

  /**
   * One pass of Hearth's care loop. Designed to be invoked by an Alexa+ routine (e.g. every
   * 15 minutes) or by the agent itself. It is idempotent: every escalation step has a
   * dedupe key, so running it twice never double-texts a family member.
   */
  async runCareRounds() {
    const now = this.clock.now();
    const date = this.today(now);
    const local = zonedParts(now, this.tz);
    const actions: { kind: string; detail: string; to?: string; delivered?: string }[] = [];
    const did = (key: string) => this.state.escalations.some((e) => e.key === key);
    const mark = (doseId: string, step: "reminder" | "primary" | "circle") =>
      this.store.mutate("escalation", (s) => s.escalations.push({ key: `${doseId}:${step}`, doseId, step, at: now.toISOString() }));

    // 1. Missed / late doses → escalation ladder.
    for (const d of this.dosesFor(date, now)) {
      if (!["late", "missed"].includes(d.status)) continue;
      if (d.minutesLate >= POLICY.reminderAfter && !did(`${d.id}:reminder`)) {
        const n = await this.notify(this.recipient.id, {
          severity: "info",
          title: `Reminder: ${d.name}`,
          body: `${this.recipient.name}, it's time for your ${d.purpose} pill (${d.name}, ${d.timeLabel}). Say "Alexa, I took it" when you're done.`,
          reason: `missed_dose:${d.id}`,
        });
        mark(d.id, "reminder");
        actions.push({ kind: "reminder", detail: `Gentle reminder for ${d.name} (${d.timeLabel}) announced on the Echo`, to: this.recipient.name, delivered: n.delivered });
      }
      if (d.minutesLate >= POLICY.notifyPrimaryAfter && !did(`${d.id}:primary`)) {
        const n = await this.notify(this.primary.id, {
          severity: "attention",
          title: `⏰ ${this.recipient.name} hasn't logged ${d.name}`,
          body: `The ${d.timeLabel} dose (${d.purpose}) is ${d.minutesLate} min overdue. Hearth already reminded her on the Echo. Tap to call or send her a note.`,
          reason: `missed_dose:${d.id}`,
        });
        mark(d.id, "primary");
        actions.push({ kind: "notify_primary", detail: `${d.name} ${d.minutesLate} min overdue`, to: this.primary.name, delivered: n.delivered });
      }
      if (d.minutesLate >= POLICY.notifyCircleAfter && !did(`${d.id}:circle`)) {
        for (const p of this.state.people.filter((x) => x.role === "caregiver")) {
          const n = await this.notify(p.id, {
            severity: "attention",
            title: `${this.recipient.name} missed ${d.name}`,
            body: `Still not logged ${Math.round(d.minutesLate / 60)}h after ${d.timeLabel}. ${this.primary.name} was notified at ${POLICY.notifyPrimaryAfter} min.`,
            reason: `missed_dose:${d.id}`,
          });
          actions.push({ kind: "notify_circle", detail: `${d.name} still missing`, to: p.name, delivered: n.delivered });
        }
        mark(d.id, "circle");
      }
    }

    // 2. Daily check-in.
    const hasCheckIn = this.state.checkIns.some((c) => c.date === date);
    const mins = local.minutesOfDay;
    const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
    if (!hasCheckIn && mins >= at(POLICY.checkInReminderAt) && !did(`${date}:checkin:reminder`)) {
      await this.notify(this.recipient.id, { severity: "info", title: "Morning check-in", body: `${this.recipient.name}, how are you feeling today? Say "Alexa, let's do my check-in."`, reason: `checkin_missing:${date}` });
      mark(`${date}:checkin`, "reminder");
      actions.push({ kind: "reminder", detail: "Check-in reminder announced", to: this.recipient.name });
    }
    if (!hasCheckIn && mins >= at(POLICY.checkInNotifyAt) && !did(`${date}:checkin:primary`)) {
      const n = await this.notify(this.primary.id, { severity: "attention", title: `No check-in from ${this.recipient.name} yet`, body: `It's ${formatTime(now, this.tz)} her time and there's no check-in today. Might be worth a call.`, reason: `checkin_missing:${date}` });
      mark(`${date}:checkin`, "primary");
      actions.push({ kind: "notify_primary", detail: "No check-in by 1 PM", to: this.primary.name, delivered: n.delivered });
    }

    // 3. Refill forecasting → quote ready for one-tap confirmation.
    for (const med of this.state.medications) {
      const days = this.daysOfSupply(med);
      const open = this.state.orders.some((o) => o.medId === med.id && o.status !== "delivered");
      const quoted = this.state.quotes.some((q) => q.medId === med.id && new Date(q.expiresAt) > now);
      if (days <= med.refillThresholdDays && !open && !quoted && !did(`${date}:refill:${med.id}:primary`)) {
        const q = await this.quoteRefill({ medication: med.id, requestedBy: "hearth" });
        if (q.ok) {
          await this.notify(this.primary.id, {
            severity: "info",
            title: `💊 ${med.name} runs out in ${Math.floor(days)} days`,
            body: `Refill ready at ${q.quote.pharmacy}: ${q.quote.quantity} tablets, $${q.quote.copay.toFixed(2)} copay, ${q.quote.delivery.toLowerCase()}. Confirm from the Hearth dashboard or ask Alexa.`,
            reason: `refill:${med.id}:${date}`,
          });
          mark(`${date}:refill:${med.id}`, "primary");
          actions.push({ kind: "refill_quote", detail: `${med.name}: ${Math.floor(days)} days left → quote ${q.quote.token.slice(0, 8)} awaiting confirmation`, to: this.primary.name });
        }
      }
    }

    // 4. Unread family messages → let Alexa read them.
    const unread = this.state.messages.filter((m) => m.to === this.recipient.id && !m.readAt);
    if (unread.length) actions.push({ kind: "messages_waiting", detail: `${unread.length} message(s) from family waiting for ${this.recipient.name}` });

    this.store.mutate("rounds", (s) => s.activity.push({ at: now.toISOString(), actor: "hearth", text: `Care rounds: ${actions.length} action(s)` }));
    return {
      ok: true as const,
      ranAt: now.toISOString(),
      localTime: formatTime(now, this.tz),
      actions,
      summary: actions.length ? actions.map((a) => `${a.kind}: ${a.detail}${a.to ? ` → ${a.to}` : ""}`).join("; ") : "All good. Nothing needs attention right now.",
    };
  }

  // ------------------------------------------------------------------ refills (purchasing)

  async quoteRefill(input: { medication: string; requestedBy?: string }) {
    const med = this.resolveMed(input.medication);
    if (!med) return { ok: false as const, error: `Unknown medication "${input.medication}".` };
    if (med.refillsLeft <= 0) return { ok: false as const, error: `No refills left on ${med.rxNumber}. ${this.state.household.careTeam.doctor} needs to renew the prescription.` };
    const now = this.clock.now();
    const q = await this.pharmacy.quote(med, now);
    const quote = {
      token: randomUUID(),
      medId: med.id,
      quantity: q.quantity,
      copay: q.copay,
      delivery: q.delivery,
      deliveryEta: q.deliveryEta,
      pharmacy: this.pharmacy.name,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + POLICY.quoteTtlMinutes * 60_000).toISOString(),
      requestedBy: input.requestedBy ?? this.recipient.id,
    };
    this.store.mutate("quote", (s) => {
      s.quotes = s.quotes.filter((x) => x.medId !== med.id);
      s.quotes.push(quote);
    });
    return {
      ok: true as const,
      quote,
      medication: { id: med.id, name: med.name, strength: med.strength, rxNumber: med.rxNumber, daysLeft: Math.floor(this.daysOfSupply(med)), refillsLeft: med.refillsLeft },
      sandbox: this.pharmacy.sandbox,
      requiresConfirmation: true,
      confirmPrompt: `Order ${q.quantity} tablets of ${med.name} ${med.strength} from ${this.pharmacy.name} for a $${q.copay.toFixed(2)} copay, ${q.delivery.toLowerCase()}?`,
    };
  }

  async confirmRefill(input: { token: string; confirmedBy: string }) {
    const now = this.clock.now();
    const quote = this.state.quotes.find((q) => q.token === input.token);
    if (!quote) {
      const existing = this.state.orders.find((o) => o.id === input.token);
      return { ok: false as const, error: existing ? "Already ordered." : "That refill quote wasn't found. Ask for a new quote." };
    }
    if (new Date(quote.expiresAt) < now) return { ok: false as const, error: "That quote expired. Ask for a fresh one so the price is current." };
    const med = this.state.medications.find((m) => m.id === quote.medId)!;
    const placed = await this.pharmacy.place(med, quote.quantity, now);
    const confirmer = this.findPerson(input.confirmedBy) ?? this.recipient;
    const order = {
      id: placed.orderId,
      medId: med.id,
      quantity: quote.quantity,
      copay: quote.copay,
      pharmacy: quote.pharmacy,
      status: "placed" as const,
      placedAt: now.toISOString(),
      confirmedBy: confirmer.id,
      deliveryEta: placed.deliveryEta,
    };
    this.store.mutate("order", (s) => {
      s.quotes = s.quotes.filter((q) => q.token !== quote.token);
      s.orders.push(order);
      const m = s.medications.find((x) => x.id === med.id)!;
      m.refillsLeft -= 1;
      s.activity.push({ at: order.placedAt, actor: confirmer.id, text: `Ordered ${med.name} refill (${order.id})` });
    });
    const etaLabel = new Intl.DateTimeFormat("en-US", { timeZone: this.tz, weekday: "long" }).format(new Date(order.deliveryEta));
    for (const p of this.state.people.filter((x) => x.id !== confirmer.id && x.role !== "caregiver")) {
      await this.notify(p.id, {
        severity: "info",
        title: `📦 ${med.name} refill ordered`,
        body: `${confirmer.name} confirmed order ${order.id}: ${order.quantity} tablets, $${order.copay.toFixed(2)}, arriving ${etaLabel}.`,
        reason: `order:${order.id}`,
      });
    }
    return { ok: true as const, order: { ...order, medication: `${med.name} ${med.strength}`, arrives: etaLabel }, sandbox: this.pharmacy.sandbox };
  }

  // ------------------------------------------------------------------ family dashboard

  weekly(now = this.clock.now()) {
    const today = this.today(now);
    const days = [];
    for (let back = 6; back >= 0; back--) {
      const date = addDays(today, -back);
      const doses = this.dosesFor(date, now);
      const closed = back === 0 ? doses.filter((d) => !["upcoming", "due"].includes(d.status)) : doses;
      const taken = closed.filter((d) => d.status === "taken").length;
      const checkIn = this.state.checkIns.find((c) => c.date === date) ?? null;
      days.push({
        date,
        weekday: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)),
        isToday: back === 0,
        taken,
        scheduled: closed.length,
        doses: doses.map((d) => ({ name: d.name, time: d.timeLabel, status: d.status, minutesLate: d.status === "taken" ? Math.max(0, Math.floor((new Date(d.loggedAt!).getTime() - localInstant(this.tz, date, d.time).getTime()) / 60_000)) : d.minutesLate })),
        mood: checkIn?.mood ?? null,
        sleep: checkIn?.sleep ?? null,
        pain: checkIn?.pain ?? null,
        note: checkIn?.note ?? null,
      });
    }
    const totalTaken = days.reduce((a, d) => a + d.taken, 0);
    const totalScheduled = days.reduce((a, d) => a + d.scheduled, 0);
    const recentAlerts = this.state.notifications.filter((n) => n.to !== this.recipient.id).slice(-8).reverse();
    return {
      person: this.recipient.name,
      viewer: this.primary.name,
      adherencePct: totalScheduled ? Math.round((totalTaken / totalScheduled) * 100) : 100,
      streakDays: this.streak(now),
      days,
      medications: this.state.medications.map((m) => ({ id: m.id, name: m.name, strength: m.strength, purpose: m.purpose, times: m.times.map(hhmmToLabel), daysLeft: Math.floor(this.daysOfSupply(m)), refillsLeft: m.refillsLeft, lowSupply: this.daysOfSupply(m) <= m.refillThresholdDays })),
      openQuotes: this.state.quotes.filter((q) => new Date(q.expiresAt) > now).map((q) => ({ ...q, name: this.medName(q.medId) })),
      orders: this.state.orders.slice(-5).reverse().map((o) => ({ ...o, name: this.medName(o.medId) })),
      alerts: recentAlerts.map((n) => ({ to: this.person(n.to).name, title: n.title, body: n.body, at: n.at, atLabel: formatTime(new Date(n.at), this.person(n.to).timeZone), severity: n.severity, delivered: n.delivered })),
      activity: this.state.activity.slice(-10).reverse(),
      circle: this.state.people.map((p) => ({ name: p.name, relationship: p.relationship, role: p.role, channel: p.channel })),
      careTeam: this.state.household.careTeam,
    };
  }

  summaryText(now = this.clock.now()): string {
    const w = this.weekly(now);
    const t = this.todayBoard(now);
    const moods = w.days.filter((d) => d.mood).map((d) => `${d.weekday} ${d.mood}`).join(", ");
    const missed = w.days.flatMap((d) => d.doses.filter((x) => x.status === "missed").map((x) => `${d.weekday} ${x.name} ${x.time}`));
    return [
      `${w.person}: ${w.adherencePct}% of doses taken over the last 7 days; current streak ${w.streakDays} day(s).`,
      missed.length ? `Missed: ${missed.join("; ")}.` : "No missed doses this week.",
      `Today so far: ${t.takenCount}/${t.totalCount} doses logged${t.nextUp ? `, next is ${t.nextUp.name} at ${t.nextUp.timeLabel} (${t.nextUp.status})` : ""}.`,
      t.checkIn ? `Today's check-in: mood ${t.checkIn.mood}, sleep ${t.checkIn.sleep}, pain ${t.checkIn.pain}${t.checkIn.note ? ` ("${t.checkIn.note}")` : ""}.` : "No check-in yet today.",
      `Mood this week: ${moods}.`,
      w.medications.filter((m) => m.lowSupply).map((m) => `${m.name} has ${m.daysLeft} days left.`).join(" "),
    ].filter(Boolean).join(" ");
  }
}
