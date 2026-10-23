import { addDays, localInstant, zonedParts } from "./clock.js";

export type Channel = "alexa_announcement" | "push" | "sms" | "email";

export interface Person {
  id: string;
  name: string;
  relationship: string;
  role: "care_recipient" | "primary_caregiver" | "caregiver";
  channel: Channel;
  timeZone: string;
  /** Local quiet hours for non-urgent alerts, e.g. ["22:00","07:00"]. */
  quietHours?: [string, string];
}

export interface Medication {
  id: string;
  name: string;
  strength: string;
  purpose: string; // plain-language label the family wrote, never generated advice
  instructions: string; // copied from the label by the family
  times: string[]; // local "HH:MM"
  pillsPerDose: number;
  pillsRemaining: number;
  refillThresholdDays: number;
  pharmacy: string;
  rxNumber: string;
  refillsLeft: number;
}

export type DoseStatus = "taken" | "skipped";

export interface DoseLog {
  id: string; // `${date}:${medId}:${time}`
  medId: string;
  date: string;
  time: string;
  status: DoseStatus;
  at: string; // ISO instant it was logged
  by: string; // person id or "alexa"
  note?: string;
}

export type Mood = "great" | "okay" | "low";
export type Sleep = "well" | "so-so" | "poorly";
export type Pain = "none" | "some" | "a lot";

export interface CheckIn {
  date: string;
  at: string;
  mood: Mood;
  sleep: Sleep;
  pain: Pain;
  note?: string;
}

export interface FamilyMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  at: string;
  readAt?: string;
}

export interface Notification {
  id: string;
  to: string; // person id
  channel: Channel;
  severity: "info" | "attention" | "urgent";
  title: string;
  body: string;
  at: string;
  reason: string; // machine-readable reason, e.g. "missed_dose:2026-10-23:metformin:08:00"
  delivered: "sent" | "held_quiet_hours" | "webhook_failed";
}

export interface EscalationStep {
  key: string; // dedupe key: `${doseId}:${step}`
  doseId: string;
  step: "reminder" | "primary" | "circle";
  at: string;
}

export interface RefillQuote {
  token: string;
  medId: string;
  quantity: number;
  copay: number;
  delivery: string;
  deliveryEta: string;
  pharmacy: string;
  createdAt: string;
  expiresAt: string;
  requestedBy: string;
}

export interface Order {
  id: string;
  medId: string;
  quantity: number;
  copay: number;
  pharmacy: string;
  status: "placed" | "shipped" | "delivered";
  placedAt: string;
  confirmedBy: string;
  deliveryEta: string;
}

export interface Preference {
  key: string;
  value: string;
  setBy: string;
  at: string;
}

export interface HearthState {
  version: 1;
  household: {
    name: string;
    timeZone: string;
    careRecipientId: string;
    careTeam: { doctor: string; doctorPhone: string; pharmacist: string; pharmacyPhone: string };
  };
  people: Person[];
  medications: Medication[];
  doses: DoseLog[];
  checkIns: CheckIn[];
  messages: FamilyMessage[];
  notifications: Notification[];
  escalations: EscalationStep[];
  quotes: RefillQuote[];
  orders: Order[];
  preferences: Preference[];
  activity: { at: string; actor: string; text: string }[];
}

/**
 * Seed a realistic household: Rosa (78) lives alone in Tucson; her son Daniel in Seattle
 * is the primary caregiver and her daughter Ana in Chicago is in the circle.
 * Seven days of history are generated relative to `now` so the dashboard has real trends.
 */
export function seedState(now: Date): HearthState {
  const tz = "America/Phoenix";
  const today = zonedParts(now, tz).date;
  const meds: Medication[] = [
    {
      id: "lisinopril",
      name: "Lisinopril",
      strength: "10 mg",
      purpose: "blood pressure",
      instructions: "1 tablet by mouth every morning",
      times: ["08:00"],
      pillsPerDose: 1,
      pillsRemaining: 21,
      refillThresholdDays: 5,
      pharmacy: "Desert Bloom Pharmacy",
      rxNumber: "RX-4471902",
      refillsLeft: 3,
    },
    {
      id: "metformin",
      name: "Metformin",
      strength: "500 mg",
      purpose: "blood sugar",
      instructions: "1 tablet by mouth twice daily with meals",
      times: ["08:00", "19:00"],
      pillsPerDose: 1,
      pillsRemaining: 7,
      refillThresholdDays: 5,
      pharmacy: "Desert Bloom Pharmacy",
      rxNumber: "RX-4471903",
      refillsLeft: 2,
    },
    {
      id: "atorvastatin",
      name: "Atorvastatin",
      strength: "20 mg",
      purpose: "cholesterol",
      instructions: "1 tablet by mouth at bedtime",
      times: ["21:00"],
      pillsPerDose: 1,
      pillsRemaining: 40,
      refillThresholdDays: 5,
      pharmacy: "Desert Bloom Pharmacy",
      rxNumber: "RX-4471904",
      refillsLeft: 5,
    },
  ];

  const doses: DoseLog[] = [];
  const checkIns: CheckIn[] = [];
  // Deterministic, believable history: mostly on time, one missed evening dose 3 days ago,
  // one late morning 5 days ago.
  const moods: Mood[] = ["okay", "great", "okay", "low", "okay", "great", "great"];
  const sleeps: Sleep[] = ["well", "well", "so-so", "poorly", "so-so", "well", "well"];
  const pains: Pain[] = ["none", "none", "some", "some", "none", "none", "none"];
  for (let back = 7; back >= 1; back--) {
    const date = addDays(today, -back);
    for (const med of meds) {
      for (const time of med.times) {
        if (back === 3 && med.id === "metformin" && time === "19:00") continue; // missed
        const lateMin = back === 5 && time === "08:00" ? 95 : (back * 7 + time.length * 3) % 22;
        const at = new Date(localInstant(tz, date, time).getTime() + lateMin * 60_000);
        doses.push({ id: `${date}:${med.id}:${time}`, medId: med.id, date, time, status: "taken", at: at.toISOString(), by: "alexa" });
      }
    }
    const i = 7 - back;
    checkIns.push({
      date,
      at: new Date(localInstant(tz, date, "09:10").getTime() + i * 240_000).toISOString(),
      mood: moods[i],
      sleep: sleeps[i],
      pain: pains[i],
      note: back === 4 ? "Knee was stiff after gardening" : undefined,
    });
  }

  return {
    version: 1,
    household: {
      name: "Rosa's home",
      timeZone: tz,
      careRecipientId: "rosa",
      careTeam: { doctor: "Dr. Patel", doctorPhone: "(520) 555-0142", pharmacist: "Desert Bloom Pharmacy", pharmacyPhone: "(520) 555-0199" },
    },
    people: [
      { id: "rosa", name: "Rosa", relationship: "Mom", role: "care_recipient", channel: "alexa_announcement", timeZone: tz },
      { id: "daniel", name: "Daniel", relationship: "son", role: "primary_caregiver", channel: "push", timeZone: "America/Los_Angeles", quietHours: ["22:30", "06:30"] },
      { id: "ana", name: "Ana", relationship: "daughter", role: "caregiver", channel: "sms", timeZone: "America/Chicago", quietHours: ["22:00", "07:00"] },
    ],
    medications: meds,
    doses,
    checkIns,
    messages: [
      { id: "m1", from: "ana", to: "rosa", text: "Kids loved the tamales recipe! Calling you Sunday ❤️", at: new Date(now.getTime() - 15 * 3600_000).toISOString() },
    ],
    notifications: [],
    escalations: [],
    quotes: [],
    orders: [],
    preferences: [
      { key: "reminder_style", value: "Short and warm. Use her name. One question at a time.", setBy: "daniel", at: new Date(now.getTime() - 9 * 86400_000).toISOString() },
    ],
    activity: [],
  };
}
