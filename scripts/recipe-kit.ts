import type { RecipeStep } from "./seed-recipes";

/*
  Steps the recipe libraries share. A module of its own because seed-recipes
  imports the specialty packs, and the packs use these too: importing them from
  seed-recipes would be a cycle that hands the packs an undefined function.
*/

/*
  "Reply 1 and we'll book you" — the step a recall, a follow-up or a missed
  visit ends on, so that the patient's yes becomes an appointment without
  anybody picking up the phone.

  The flow books the first free time (the "Book an appointment" step) like the
  visit it is about, or like the patient's last visit when it is about none,
  and tells them when. Already booked: they are told the time they have.
  Nothing free in the next two weeks: they go on the waitlist, are told so,
  and reception gets a task. A reply that is not a yes — a question, "next
  month" — is flagged for a person to answer. No reply leaves `onSilence`.
*/
export const BOOK_WORDS = ["1", "نعم", "اكيد", "احجز", "احجزلي", "تمام", "موافق", "ماشي", "ok", "yes", "book", "👍"];

export function replyToBook(opts: {
  /** "trigger": like the appointment the flow is about; "last": like the patient's last finished visit. */
  like: "trigger" | "last";
  /** Book from this many days on. */
  afterDays?: number;
  /** How long to wait for the answer. */
  waitDays?: number;
  /** What happens when the patient does not answer. */
  onSilence?: RecipeStep[];
}): RecipeStep {
  return {
    step_type: "wait_for_reply",
    config: { amount: opts.waitDays ?? 2, unit: "days", options: [{ label: "احجز", keywords: BOOK_WORDS }] },
    children: {
      "opt:0": [
        {
          step_type: "book_appointment",
          config: {
            service: opts.like,
            doctor: opts.like,
            after_days: opts.afterDays ?? 1,
            from: "now",
            search_days: 14,
            part_of_day: "any",
            // They asked for it: booked as confirmed.
            status: "confirmed",
            skip_if_booked: true,
          },
          children: {
            booked: [
              {
                step_type: "send_whatsapp",
                config: {
                  message:
                    "تم ✅ حجزنالك موعد في {{clinic.name}}:\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n👨‍⚕️ {{appointment.doctor}}\n\nإذا الوقت مش مناسب ردّ علينا هنا ومنغيّره.",
                },
              },
            ],
            already_booked: [
              {
                step_type: "send_whatsapp",
                config: {
                  message: "عندك موعد قادم في {{clinic.name}} ✅\n📅 {{appointment.date}}\n🕐 {{appointment.time}}\n\nبانتظارك 🌷",
                },
              },
            ],
            no_slot: [
              {
                step_type: "add_to_waitlist",
                config: { service: opts.like, doctor: opts.like, within_days: 21, note: "طلب موعداً بالرد على رسالة تلقائية" },
              },
              {
                step_type: "send_whatsapp",
                config: {
                  message: "ما في وقت فاضي قريب حالياً 🙏 سجّلناك على قائمة الانتظار، ورح نتواصل معك أول ما يفضى موعد.",
                },
              },
              {
                step_type: "create_task",
                config: {
                  title: "رتّب موعداً لـ{{patient.name}}",
                  body: "طلب موعداً بالرد على رسالة تلقائية ولا يوجد وقت متاح خلال أسبوعين — أُضيف لقائمة الانتظار.",
                  due_amount: 1,
                  due_unit: "days",
                  assignee: "nobody",
                },
              },
            ],
          },
        },
      ],
      other: [
        { step_type: "flag_conversation", config: { reason: "ردّ على دعوة للحجز" } },
        {
          step_type: "notify_staff",
          config: { title: "{{patient.name}} ردّ على دعوة للحجز", body: "«{{reply.text}}»", roles: ["receptionist"] },
        },
      ],
      ...(opts.onSilence ? { timeout: opts.onSilence } : {}),
    },
  };
}

/*
  Words that mean "yes, I'll come" and "I need to change it", as patients in
  Jordan actually type them. Matching ignores tashkeel, alef and taa-marbuta
  spelling and reads ١ as 1, so one spelling of each is enough.
*/
export const CONFIRM_WORDS = ["1", "نعم", "اكيد", "تمام", "موافق", "تأكيد", "ok", "yes", "confirm", "👍"];
export const CHANGE_WORDS = ["2", "تغيير", "تأجيل", "الغاء", "لا", "مش رح اقدر", "change", "cancel", "no"];

/** Stop here when the patient already has a visit ahead — the reminder has nothing to ask for. */
export const UNLESS_BOOKED: RecipeStep = {
  step_type: "condition",
  config: { match: "all", rules: [{ kind: "has_upcoming_appointment" }] },
  children: { yes: [{ step_type: "stop", config: {} }] },
};

/** A to-do to phone the patient, for the ones who did not answer. */
export const callTask = (title: string, body: string): RecipeStep[] => [
  { step_type: "create_task", config: { title, body, due_amount: 1, due_unit: "days", assignee: "nobody" } },
];
