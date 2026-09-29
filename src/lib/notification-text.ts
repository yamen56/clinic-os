import { DateTime } from "luxon";

/**
 * The words of the notifications the platform writes on its own — reminders,
 * summaries, the instant appointment alerts.
 *
 * In the recipient's language rather than always Arabic. They were hard-coded
 * Arabic in the worker, so a doctor who reads the app in English was reminded
 * about their next patient in a language they had chosen not to read it in.
 * `users.locale` is 'ar' unless somebody chose otherwise, so for most people
 * nothing reads differently.
 *
 * Kept apart from the UI dictionaries on purpose: the worker needs a handful of
 * sentences, not the whole application's vocabulary.
 */

export type NLocale = "ar" | "en";

export const asLocale = (v: unknown): NLocale => (v === "en" ? "en" : "ar");

const LUXON_LOCALE: Record<NLocale, string> = { ar: "ar-JO-u-nu-latn", en: "en-GB" };

/** A time of day, as it reads on a lock screen. */
export function clock(at: Date | string, tz: string, locale: NLocale): string {
  return DateTime.fromJSDate(new Date(at)).setZone(tz).setLocale(LUXON_LOCALE[locale]).toFormat("h:mm a");
}

/** A day and a time, for an appointment that is not necessarily today. */
export function when(at: Date | string, tz: string, locale: NLocale): string {
  return DateTime.fromJSDate(new Date(at))
    .setZone(tz)
    .setLocale(LUXON_LOCALE[locale])
    .toFormat("cccc d LLLL, h:mm a");
}

const ar = {
  reminderOwn: (t: string) => `موعدك القادم ${t}`,
  reminderOther: (t: string) => `موعد قادم ${t}`,
  appts: (n: number) => `${n} ${n === 1 ? "موعد" : "مواعيد"}`,
  dayOwn: (n: string) => `جدول اليوم: ${n}`,
  dayClinic: (n: string) => `مواعيد العيادة اليوم: ${n}`,
  tomorrowOwn: (n: string) => `جدول الغد: ${n}`,
  tomorrowClinic: (n: string) => `مواعيد العيادة غداً: ${n}`,
  firstAt: (t: string) => `أول موعد الساعة ${t}`,
  unconfirmedTitle: (n: number) => `${n} ${n === 1 ? "موعد غداً لم يُؤكَّد" : "مواعيد غداً لم تُؤكَّد"} بعد`,
  unconfirmedBody: "تواصل مع المرضى لتأكيدها قبل نهاية اليوم.",
  dayEndTitle: "ملخص اليوم",
  dayEndBody: (done: number, noShow: number) => `${done} موعد مكتمل · ${noShow} لم يحضر`,
  weekTitle: "ملخص الأسبوع",
  weekBody: (done: number, noShow: number, cancelled: number, fresh: number) =>
    `${done} مكتمل · ${noShow} لم يحضر · ${cancelled} ملغى · ${fresh} مريض جديد`,
  unreadTitle: (n: number) => `${n} رسالة غير مقروءة`,
  unreadBody: "محادثات بانتظار الرد",
  bookedOwn: (p: string) => `موعد جديد معك: ${p}`,
  bookedOther: (p: string) => `موعد جديد: ${p}`,
  cancelledTitle: (p: string) => `أُلغي موعد: ${p}`,
  movedTitle: (p: string) => `تغيّر موعد: ${p}`,
  movedBody: (now: string, was: string) => `${now} (كان ${was})`,
  awayTitle: (p: string) => `لم يعد موعد ${p} معك`,
  awayBody: (w: string, doctor: string) => `${w} · نُقل إلى ${doctor}`,
  unassigned: "بدون طبيب",
  testTitle: "إشعار تجريبي",
  testBody: "إن وصلك هذا فالإشعارات تعمل على هذا الجهاز.",
  heldTitle: (n: number) => `${n} إشعارات جديدة`,
  heldBody: "وصلت أثناء ساعات الهدوء.",
};

const en: typeof ar = {
  reminderOwn: (t) => `Your next appointment at ${t}`,
  reminderOther: (t) => `Upcoming appointment at ${t}`,
  appts: (n) => `${n} ${n === 1 ? "appointment" : "appointments"}`,
  dayOwn: (n) => `Today: ${n}`,
  dayClinic: (n) => `Clinic today: ${n}`,
  tomorrowOwn: (n) => `Tomorrow: ${n}`,
  tomorrowClinic: (n) => `Clinic tomorrow: ${n}`,
  firstAt: (t) => `First one at ${t}`,
  unconfirmedTitle: (n) =>
    `${n} ${n === 1 ? "appointment tomorrow isn't" : "appointments tomorrow aren't"} confirmed yet`,
  unconfirmedBody: "Reach the patients to confirm before the day ends.",
  dayEndTitle: "End of day",
  dayEndBody: (done, noShow) => `${done} completed · ${noShow} no-show`,
  weekTitle: "Your week",
  weekBody: (done, noShow, cancelled, fresh) =>
    `${done} completed · ${noShow} no-show · ${cancelled} cancelled · ${fresh} new ${fresh === 1 ? "patient" : "patients"}`,
  unreadTitle: (n) => `${n} unread ${n === 1 ? "message" : "messages"}`,
  unreadBody: "Conversations waiting for a reply",
  bookedOwn: (p) => `New appointment with you: ${p}`,
  bookedOther: (p) => `New appointment: ${p}`,
  cancelledTitle: (p) => `Cancelled: ${p}`,
  movedTitle: (p) => `Moved: ${p}`,
  movedBody: (now, was) => `${now} (was ${was})`,
  awayTitle: (p) => `${p} is no longer with you`,
  awayBody: (w, doctor) => `${w} · moved to ${doctor}`,
  unassigned: "no doctor",
  testTitle: "Test notification",
  testBody: "If you can see this, notifications work on this device.",
  heldTitle: (n) => `${n} new notifications`,
  heldBody: "They arrived during your quiet hours.",
};

export const NT: Record<NLocale, typeof ar> = { ar, en };
