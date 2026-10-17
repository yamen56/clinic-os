import { renderSystemMessage } from "../system-messages";
import type { Ctx } from "./catalog";

/**
 * The {{variables}} a flow's messages can use, and what each one needs.
 *
 * A message on a birthday flow that says {{appointment.time}} renders to
 * nothing, because a birthday has no appointment. The builder offers only the
 * variables the trigger can fill, and warns about any already typed that it
 * cannot.
 */

export type TemplateContext = Record<string, Record<string, string>>;

export type VariableGroup = {
  group: "patient" | "appointment" | "next_appointment" | "doctor" | "clinic" | "invoice" | "document" | "reply";
  /** The context the group is read from; none means always available. */
  needs?: Ctx;
  vars: string[];
};

export const VARIABLE_GROUPS: VariableGroup[] = [
  { group: "patient", needs: "patient", vars: ["first_name", "name", "phone", "file_no", "age"] },
  {
    group: "appointment", needs: "appointment",
    vars: ["date", "time", "day", "end_time", "service", "doctor"],
  },
  { group: "next_appointment", needs: "patient", vars: ["date", "time", "service"] },
  { group: "doctor", needs: "appointment", vars: ["name"] },
  { group: "clinic", vars: ["name", "phone", "address", "map_link", "booking_link", "review_link"] },
  { group: "invoice", needs: "invoice", vars: ["number", "total", "paid", "balance", "link"] },
  { group: "document", needs: "document", vars: ["title", "status", "expires"] },
  { group: "reply", needs: "conversation", vars: ["text"] },
];

/**
 * Groups available to a flow on this trigger. The reply group is also offered
 * whenever the flow waits for a reply, which is where most replies come from.
 */
export function availableGroups(provides: Ctx[], hasReplyStep: boolean): VariableGroup[] {
  return VARIABLE_GROUPS.filter((g) => {
    if (!g.needs) return true;
    if (g.group === "reply") return hasReplyStep || provides.includes("conversation");
    return provides.includes(g.needs);
  });
}

/** Every {{group.key}} in a text. */
export function variablesIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
}

/** Variables in the text that this trigger cannot fill. */
export function unavailableVariables(text: string, provides: Ctx[], hasReplyStep: boolean): string[] {
  const ok = new Set(
    availableGroups(provides, hasReplyStep).flatMap((g) => g.vars.map((v) => `${g.group}.${v}`))
  );
  const known = new Set(VARIABLE_GROUPS.flatMap((g) => g.vars.map((v) => `${g.group}.${v}`)));
  return [...new Set(variablesIn(text))].filter((v) => known.has(v) && !ok.has(v));
}

function flatten(ctx: TemplateContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [group, values] of Object.entries(ctx)) {
    for (const [key, value] of Object.entries(values ?? {})) out[`${group}.${key}`] = value ?? "";
  }
  return out;
}

/**
 * Fills a message in, dropping any line that held only variables which came
 * back empty — the same rule as the platform's own messages, so a clinic with
 * no map link does not send a line reading "📍 ".
 */
export function renderMessage(template: string, ctx: TemplateContext): string {
  return renderSystemMessage(template, flatten(ctx));
}

/** What the preview shows before a real patient is picked. */
export function sampleContext(locale: "ar" | "en"): TemplateContext {
  const ar = locale === "ar";
  return {
    patient: {
      first_name: ar ? "أحمد" : "Ahmad",
      name: ar ? "أحمد خالد" : "Ahmad Khaled",
      phone: "+962790000000",
      file_no: "1024",
      age: "34",
    },
    appointment: {
      date: ar ? "الأحد 19 تشرين الأول" : "Sunday 19 October",
      time: ar ? "4:30 م" : "4:30 PM",
      day: ar ? "غداً" : "tomorrow",
      end_time: ar ? "5:00 م" : "5:00 PM",
      service: ar ? "تنظيف أسنان" : "Dental cleaning",
      doctor: ar ? "د. سارة" : "Dr. Sara",
    },
    next_appointment: {
      date: ar ? "الأحد 19 تشرين الأول" : "Sunday 19 October",
      time: ar ? "4:30 م" : "4:30 PM",
      service: ar ? "تنظيف أسنان" : "Dental cleaning",
    },
    doctor: { name: ar ? "د. سارة" : "Dr. Sara" },
    clinic: {
      name: ar ? "عيادتك" : "Your clinic",
      phone: "+96265000000",
      address: ar ? "عمّان، شارع المدينة المنورة" : "Medina St, Amman",
      map_link: "https://maps.google.com/…",
      booking_link: "https://clinicti.app/book/…",
      review_link: "https://g.page/r/…",
    },
    invoice: { number: "INV-1042", total: "45.00 JOD", paid: "20.00 JOD", balance: "25.00 JOD", link: "https://clinicti.app/inv/…" },
    document: { title: ar ? "نموذج موافقة" : "Consent form", status: "sent", expires: ar ? "25 تشرين الأول" : "25 October" },
    reply: { text: ar ? "نعم" : "Yes" },
  };
}
