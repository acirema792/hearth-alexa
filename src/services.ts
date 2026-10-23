import { randomUUID } from "node:crypto";
import { zonedParts } from "./clock.js";
import type { Channel, Medication, Notification, Person } from "./model.js";

/**
 * Outbound services Hearth orchestrates. Each is an adapter with a sandbox default so the
 * project runs with zero credentials, and a real implementation behind an env var.
 */

// ---------------------------------------------------------------- notifications

export interface NotifyResult {
  delivered: Notification["delivered"];
}

/**
 * Family notification adapter. Every notification is recorded in the household outbox and
 * streamed to the Hearth companion page. If HEARTH_WEBHOOK_URL is set, it is also POSTed as
 * JSON, which plugs straight into n8n, Zapier, ntfy, Slack workflows or an SMS gateway.
 */
export class Notifier {
  constructor(private readonly webhookUrl = process.env.HEARTH_WEBHOOK_URL) {}

  inQuietHours(person: Person, now: Date): boolean {
    if (!person.quietHours) return false;
    const [start, end] = person.quietHours.map((t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    });
    const mins = zonedParts(now, person.timeZone).minutesOfDay;
    return start > end ? mins >= start || mins < end : mins >= start && mins < end;
  }

  async send(
    person: Person,
    n: { severity: Notification["severity"]; title: string; body: string; reason: string },
    now: Date,
  ): Promise<Notification> {
    const held = n.severity !== "urgent" && this.inQuietHours(person, now);
    const note: Notification = {
      id: randomUUID(),
      to: person.id,
      channel: person.channel as Channel,
      severity: n.severity,
      title: n.title,
      body: n.body,
      at: now.toISOString(),
      reason: n.reason,
      delivered: held ? "held_quiet_hours" : "sent",
    };
    if (!held && this.webhookUrl) {
      try {
        const res = await fetch(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "hearth", to: { id: person.id, name: person.name, channel: person.channel }, ...n, at: note.at }),
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) note.delivered = "webhook_failed";
      } catch {
        note.delivered = "webhook_failed";
      }
    }
    return note;
  }
}

// ---------------------------------------------------------------- pharmacy

export interface PharmacyQuote {
  quantity: number;
  copay: number;
  delivery: string;
  deliveryEta: string;
}

export interface Pharmacy {
  readonly name: string;
  readonly sandbox: boolean;
  quote(med: Medication, now: Date): Promise<PharmacyQuote>;
  place(med: Medication, quantity: number, now: Date): Promise<{ orderId: string; deliveryEta: string }>;
}

/**
 * Sandbox pharmacy with realistic behaviour (30-day supply, fixed generic copays, next-day
 * delivery before 2 PM cut-off). Labelled as sandbox in every response so nobody mistakes
 * a demo order for a real one.
 */
export class SandboxPharmacy implements Pharmacy {
  readonly name = "Desert Bloom Pharmacy (sandbox)";
  readonly sandbox = true;
  private copays: Record<string, number> = { lisinopril: 3.5, metformin: 4.0, atorvastatin: 6.25 };

  async quote(med: Medication, now: Date): Promise<PharmacyQuote> {
    const perDay = med.pillsPerDose * med.times.length;
    const beforeCutoff = zonedParts(now, "America/Phoenix").hour < 14;
    const eta = new Date(now.getTime() + (beforeCutoff ? 1 : 2) * 86400_000);
    return {
      quantity: perDay * 30,
      copay: this.copays[med.id] ?? 5,
      delivery: beforeCutoff ? "Free delivery tomorrow" : "Free delivery in 2 days",
      deliveryEta: eta.toISOString(),
    };
  }

  private seq = 100231;
  async place(_med: Medication, _quantity: number, now: Date) {
    const eta = new Date(now.getTime() + (zonedParts(now, "America/Phoenix").hour < 14 ? 1 : 2) * 86400_000);
    return { orderId: `DBP-${this.seq++}`, deliveryEta: eta.toISOString() };
  }
}
