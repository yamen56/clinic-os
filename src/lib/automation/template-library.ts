/*
  How the template gallery is laid out (Yamen, 2026-11-21: "there are many
  duplicating ones that the user will not understand what to choose from").

  The gallery used to offer every general template, every template of the
  clinic's specialty, and behind "All templates" another forty from other
  specialties — five kinds of post-op care, six of "how to prepare", ten
  recalls — grouped by what starts them, which put nearly everything under
  "Appointments". Now a clinic is offered only what fits it, once per job,
  grouped by what the template is for, and told which ones it already runs.
*/

export const TEMPLATE_GROUPS = ["before", "back", "after", "money", "other"] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

/** What each template is for. A key not listed here falls back on its trigger. */
const GROUP_OF: Record<string, TemplateGroup> = {
  // Before the visit: confirming it, reminding, preparing.
  welcome_new_patient: "before",
  confirm_on_booking: "before",
  first_visit_welcome: "before",
  reminder_24h: "before",
  reminder_2h: "before",
  rescheduled_notice: "before",
  booking_needs_approval: "before",
  psych_discreet_reminder: "before",
  derm_pre_session_prep: "before",
  ophtha_dilation_notice: "before",
  obgyn_scan_prep: "before",
  cardio_fasting_prep: "before",
  uro_scan_prep: "before",
  internal_fasting_labs: "before",
  plastic_pre_op_instructions: "before",
  // Bringing patients back: every "reply 1 to book".
  next_visit_due_book: "back",
  no_show_followup: "back",
  cancelled_rebook: "back",
  recall_6_months: "back",
  results_ready: "back",
  dental_crown_after_root_canal: "back",
  dental_next_visit_unbooked: "back",
  dental_ortho_recall: "back",
  derm_laser_series_recall: "back",
  ophtha_annual_exam: "back",
  obgyn_antenatal_recall: "back",
  obgyn_postpartum_checkin: "back",
  peds_vaccine_recall: "back",
  ortho_cast_removal: "back",
  physio_lapsed_series: "back",
  cardio_medication_review: "back",
  nutrition_followup_recall: "back",
  psych_missed_session_care: "back",
  psych_followup_recall: "back",
  plastic_post_op_week: "back",
  internal_chronic_recall: "back",
  coordinator_next_session: "back",
  coordinator_plan_invite: "back",
  coordinator_enquiry: "back",
  // After the visit: care, check-ins, the review.
  post_visit_review: "after",
  prescription_check_in: "after",
  dental_post_extraction: "after",
  dental_implant_aftercare: "after",
  dental_gum_surgery_aftercare: "after",
  dental_whitening_aftercare: "after",
  dental_tag_ortho_patients: "after",
  derm_post_session_care: "after",
  ophtha_post_op_care: "after",
  peds_visit_checkin: "after",
  ortho_post_op_care: "after",
  ortho_home_exercise: "after",
  physio_home_program: "after",
  ent_post_op_care: "after",
  nutrition_weekly_checkin: "after",
  plastic_post_op_day1: "after",
  uro_post_op_care: "after",
  // Money and paperwork.
  unpaid_invoice: "money",
  document_expired_alert: "money",
  document_unsigned_escalate: "money",
  document_declined_alert: "money",
  birthday: "other",
};

export function templateGroup(key: string, triggerCategory: string | undefined): TemplateGroup {
  const g = GROUP_OF[key];
  if (g) return g;
  if (triggerCategory === "billing" || triggerCategory === "documents") return "money";
  if (triggerCategory === "treatments") return "after";
  return "other";
}

/**
 * A specialty's own version of a general template — the same job, written
 * for that field. Where every specialty a clinic practises has its own, the
 * general one is not offered beside it: a psychiatry clinic sees one
 * day-before reminder (the discreet one), not two that read alike.
 */
export const REPLACES: Record<string, string> = {
  psych_discreet_reminder: "reminder_24h",
  psych_missed_session_care: "no_show_followup",
  psych_followup_recall: "recall_6_months",
  cardio_medication_review: "recall_6_months",
  internal_chronic_recall: "recall_6_months",
  ophtha_annual_exam: "recall_6_months",
  nutrition_followup_recall: "recall_6_months",
  physio_lapsed_series: "recall_6_months",
};

export type LibraryEntry = { key: string; specialty: string };

/**
 * The templates a clinic is offered: the general ones and its own
 * specialties', less any general one each of its specialties replaces.
 * `keep` lists templates it already runs, which are shown whatever else
 * would hide them — it should be able to find what it has.
 */
export function offeredTemplates<T extends LibraryEntry>(all: T[], specialties: string[], keep: ReadonlySet<string>): T[] {
  const mine = all.filter((r) => r.specialty === "general" || specialties.includes(r.specialty));
  const replacedBy = new Map<string, Set<string>>();
  for (const r of mine) {
    const general = REPLACES[r.key];
    if (general) replacedBy.set(general, new Set([...(replacedBy.get(general) ?? []), r.specialty]));
  }
  return mine.filter((r) => {
    if (keep.has(r.key) || r.specialty !== "general") return true;
    const by = replacedBy.get(r.key);
    return !(by && specialties.length > 0 && specialties.every((s) => by.has(s)));
  });
}
