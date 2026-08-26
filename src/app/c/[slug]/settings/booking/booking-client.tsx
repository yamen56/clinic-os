"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { QUESTION_TYPES, type QuestionType } from "@/lib/booking-intake";
import {
  saveBookingLinkAction,
  deleteBookingLinkAction,
  saveBookingQuestionAction,
  deleteBookingQuestionAction,
  moveBookingQuestionAction,
} from "./actions";
import {
  Plus,
  Pencil,
  Trash2,
  Copy,
  ExternalLink,
  ChevronUp,
  ChevronDown,
  ClipboardList,
  Link2,
  ListPlus,
} from "lucide-react";

type LinkRow = {
  id: string;
  name: string;
  slug: string;
  doctor_member_id: string | null;
  service_ids: string[];
  min_notice_min: number;
  max_days_ahead: number;
  slot_granularity_min: number;
  approval_mode: "instant" | "approval";
  active: boolean;
  headline: string | null;
  headline_ar: string | null;
  intro: string | null;
  intro_ar: string | null;
  success_note: string | null;
  success_note_ar: string | null;
  show_prices: boolean;
  allow_any_doctor: boolean;
  consent_text: string | null;
  consent_text_ar: string | null;
  require_consent: boolean;
};

type QuestionRow = {
  id: string;
  booking_link_id: string | null;
  label: string;
  label_ar: string | null;
  help: string | null;
  help_ar: string | null;
  field_type: QuestionType;
  options: string[];
  options_ar: string[];
  required: boolean;
  service_ids: string[];
  patient_field_key: string | null;
  active: boolean;
  display_order: number;
};

type PatientField = {
  key: string;
  label: string;
  label_ar: string | null;
  field_type: string;
  options: string[];
};

export function BookingLinksClient({
  slug,
  canEdit,
  links,
  doctors,
  services,
  questions,
  patientFields,
}: {
  slug: string;
  canEdit: boolean;
  links: LinkRow[];
  doctors: { id: string; name: string }[];
  services: { id: string; name: string; name_ar: string | null }[];
  questions: QuestionRow[];
  patientFields: PatientField[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Partial<LinkRow> | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [question, setQuestion] = useState<Partial<QuestionRow> | null>(null);
  const [deleteQuestion, setDeleteQuestion] = useState<QuestionRow | null>(null);
  const [pickField, setPickField] = useState(false);
  const [pending, start] = useTransition();

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const tb = t.bookingSettings;
  const serviceName = (s: { name: string; name_ar: string | null }) =>
    locale === "ar" ? s.name_ar || s.name : s.name;

  const save = () =>
    start(async () => {
      if (!editing) return;
      const r = await saveBookingLinkAction(slug, {
        id: editing.id,
        name: editing.name ?? "Default",
        slug: editing.slug ?? "",
        doctorMemberId: editing.doctor_member_id ?? null,
        serviceIds: editing.service_ids ?? [],
        minNoticeMin: editing.min_notice_min ?? 120,
        maxDaysAhead: editing.max_days_ahead ?? 30,
        slotGranularityMin: editing.slot_granularity_min ?? 30,
        approvalMode: editing.approval_mode ?? "instant",
        active: editing.active ?? true,
        headline: editing.headline ?? "",
        headlineAr: editing.headline_ar ?? "",
        intro: editing.intro ?? "",
        introAr: editing.intro_ar ?? "",
        successNote: editing.success_note ?? "",
        successNoteAr: editing.success_note_ar ?? "",
        showPrices: editing.show_prices ?? true,
        allowAnyDoctor: editing.allow_any_doctor ?? true,
        consentText: editing.consent_text ?? "",
        consentTextAr: editing.consent_text_ar ?? "",
        requireConsent: editing.require_consent ?? false,
      });
      if (r.error) {
        toast(
          r.error === "slug_taken"
            ? `${t.admin.slug}!`
            : r.error === "consent_text_required"
              ? tb.consentTextRequired
              : t.common.genericError,
          "error"
        );
        return;
      }
      toast(t.common.saved);
      setEditing(null);
      router.refresh();
    });

  const saveQuestion = () =>
    start(async () => {
      if (!question?.label?.trim()) return;
      const r = await saveBookingQuestionAction(slug, {
        id: question.id,
        bookingLinkId: question.booking_link_id ?? null,
        label: question.label.trim(),
        labelAr: question.label_ar ?? "",
        help: question.help ?? "",
        helpAr: question.help_ar ?? "",
        fieldType: question.field_type ?? "text",
        options: (question.options ?? []).map((o) => o.trim()).filter(Boolean),
        optionsAr: (question.options_ar ?? []).map((o) => o.trim()),
        required: !!question.required,
        serviceIds: question.service_ids ?? [],
        patientFieldKey: question.patient_field_key || null,
        active: question.active !== false,
      });
      if (r.error) {
        toast(
          r.error === "options_required"
            ? tb.optionsRequired
            : r.error === "unknown_field"
              ? t.common.genericError
              : t.common.genericError,
          "error"
        );
        return;
      }
      toast(t.common.saved);
      setQuestion(null);
      router.refresh();
    });

  const moveQuestion = (id: string, direction: "up" | "down") =>
    start(async () => {
      await moveBookingQuestionAction(slug, id, direction);
      router.refresh();
    });

  const needsOptions =
    question?.field_type === "select" || question?.field_type === "multiselect";

  return (
    /*
      `grid-cols-1`, not a bare `grid`. An implicit grid track is `auto`, which
      is bounded below by its widest item's min-content width — so a card with a
      header that cannot shrink widens the track and the whole page scrolls
      sideways on a 320px phone. `grid-cols-1` is `minmax(0, 1fr)`, which clamps
      the track to the container and lets the card shrink instead.
    */
    <div className="grid grid-cols-1 gap-5">
      <Card>
        <CardHeader
          title={tb.title}
          sub={tb.sub}
          action={
            canEdit && (
              <Button size="sm" onClick={() => setEditing({ min_notice_min: 120, max_days_ahead: 30, slot_granularity_min: 30, approval_mode: "instant", active: true, service_ids: [], show_prices: true, allow_any_doctor: true, require_consent: false })}>
                <Plus className="h-4 w-4" />
                {tb.addLink}
              </Button>
            )
          }
        />
        <ul className="divide-y divide-line">
          {links.map((l) => (
            <li key={l.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 ${l.active ? "" : "opacity-50"}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{l.name}</span>
                  <Badge status={l.approval_mode === "instant" ? "confirmed" : "pending"}>
                    {l.approval_mode === "instant" ? tb.instant : tb.manual}
                  </Badge>
                  {!l.active && <Badge status="cancelled">{t.common.inactive}</Badge>}
                </div>
                <div className="mt-0.5 text-[13px] text-ink-500" dir="ltr">
                  /book/{l.slug}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(`${origin}/book/${l.slug}`);
                    toast(tb.copied);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t.common.copy}
                </Button>
                <a href={`/book/${l.slug}`} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {tb.openPage}
                  </Button>
                </a>
                {canEdit && (
                  <>
                    <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setEditing(l)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {links.length > 1 && (
                      <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteId(l.id)}>
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* ------------------------------------------------------- the questions */}
      <Card>
        <CardHeader
          title={tb.questionsTitle}
          sub={tb.questionsSub}
          action={
            canEdit && (
              <div className="flex flex-wrap items-center gap-1.5">
                {/*
                  Two doors to the same thing, because there are two ways a
                  clinic arrives here. Either it has a question in mind and
                  types it, or it already keeps this on the patient file and
                  wants the patient to fill it in themselves — and the second
                  should not mean retyping a field that already exists.
                */}
                {patientFields.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setPickField(true)}>
                    <ListPlus className="h-4 w-4" />
                    {tb.fromPatientFields}
                  </Button>
                )}
                <Button size="sm" onClick={() => setQuestion({ field_type: "text", options: [], options_ar: [], service_ids: [], required: false, active: true, booking_link_id: null })}>
                  <Plus className="h-4 w-4" />
                  {tb.addQuestion}
                </Button>
              </div>
            )
          }
        />
        {questions.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<ClipboardList />}
              title={tb.noQuestions}
              body={tb.noQuestionsBody}
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {questions.map((q, i) => {
              const link = links.find((l) => l.id === q.booking_link_id);
              const mapped = patientFields.find((f) => f.key === q.patient_field_key);
              return (
                <li
                  key={q.id}
                  className={`flex flex-wrap items-center gap-3 px-5 py-3 ${q.active ? "" : "opacity-50"}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* A question is a sentence a clinic wrote; it has to be
                          able to break rather than push the row sideways. */}
                      <span className="min-w-0 break-words text-sm font-medium">
                        {locale === "ar" ? q.label_ar || q.label : q.label}
                      </span>
                      <Badge status="neutral">{tb.types[q.field_type]}</Badge>
                      {q.required && <Badge status="brand">{tb.required}</Badge>}
                      {!q.active && <Badge status="cancelled">{t.common.inactive}</Badge>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-ink-500">
                      <span className="inline-flex items-center gap-1">
                        <Link2 className="h-3.5 w-3.5" />
                        {link ? link.name : tb.allLinks}
                      </span>
                      {q.service_ids.length > 0 && (
                        <span className="min-w-0 break-words">
                          {tb.onlyForServices}:{" "}
                          {q.service_ids
                            .map((id) => services.find((s) => s.id === id))
                            .filter(Boolean)
                            .map((s) => serviceName(s!))
                            .join("، ")}
                        </span>
                      )}
                      {mapped && (
                        <span>
                          {tb.savesTo}: {locale === "ar" ? mapped.label_ar || mapped.label : mapped.label}
                        </span>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={tb.moveUp}
                        disabled={i === 0 || pending}
                        onClick={() => moveQuestion(q.id, "up")}
                      >
                        <ChevronUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={tb.moveDown}
                        disabled={i === questions.length - 1 || pending}
                        onClick={() => moveQuestion(q.id, "down")}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setQuestion(q)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t.common.delete}
                        onClick={() => setDeleteQuestion(q)}
                      >
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------------- link editor */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? t.common.edit : tb.addLink} wide>
        {editing && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tb.linkName} required>
                <Input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label={tb.urlSlug} required>
                <Input
                  dir="ltr"
                  value={editing.slug ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Field label={tb.minNotice}>
                <Input type="number" dir="ltr" min={0} value={editing.min_notice_min ?? 120}
                  onChange={(e) => setEditing({ ...editing, min_notice_min: Number(e.target.value) || 0 })} />
              </Field>
              <Field label={tb.maxDays}>
                <Input type="number" dir="ltr" min={1} value={editing.max_days_ahead ?? 30}
                  onChange={(e) => setEditing({ ...editing, max_days_ahead: Number(e.target.value) || 30 })} />
              </Field>
              <Field label={tb.granularity}>
                <Input type="number" dir="ltr" min={5} step={5} value={editing.slot_granularity_min ?? 30}
                  onChange={(e) => setEditing({ ...editing, slot_granularity_min: Number(e.target.value) || 30 })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tb.approval}>
                <Select
                  value={editing.approval_mode ?? "instant"}
                  onChange={(e) => setEditing({ ...editing, approval_mode: e.target.value as "instant" | "approval" })}
                >
                  <option value="instant">{tb.instant}</option>
                  <option value="approval">{tb.manual}</option>
                </Select>
              </Field>
              {doctors.length > 0 && (
                <Field label={tb.restrictDoctor}>
                  <Select
                    value={editing.doctor_member_id ?? ""}
                    onChange={(e) => setEditing({ ...editing, doctor_member_id: e.target.value || null })}
                  >
                    <option value="">{t.common.all}</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {services.length > 0 && (
              <Field label={tb.restrictServices} hint={t.common.optional}>
                <div className="flex flex-wrap gap-2">
                  {services.map((s) => {
                    const on = (editing.service_ids ?? []).includes(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() =>
                          setEditing({
                            ...editing,
                            service_ids: on
                              ? (editing.service_ids ?? []).filter((x) => x !== s.id)
                              : [...(editing.service_ids ?? []), s.id],
                          })
                        }
                        className={`rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                          on ? "border-brand-500 bg-brand-50 text-brand-800" : "border-line-strong text-ink-500"
                        }`}
                      >
                        {serviceName(s)}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            <SectionRule label={tb.pageCopy} hint={tb.pageCopyHint} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tb.headline} hint={t.common.optional}>
                <Input value={editing.headline ?? ""} onChange={(e) => setEditing({ ...editing, headline: e.target.value })} />
              </Field>
              <Field label={tb.headlineAr} hint={t.common.optional}>
                <Input dir="rtl" value={editing.headline_ar ?? ""} onChange={(e) => setEditing({ ...editing, headline_ar: e.target.value })} />
              </Field>
              <Field label={tb.intro} hint={t.common.optional}>
                <Textarea rows={3} value={editing.intro ?? ""} onChange={(e) => setEditing({ ...editing, intro: e.target.value })} />
              </Field>
              <Field label={tb.introAr} hint={t.common.optional}>
                <Textarea dir="rtl" rows={3} value={editing.intro_ar ?? ""} onChange={(e) => setEditing({ ...editing, intro_ar: e.target.value })} />
              </Field>
              <Field label={tb.successNote} hint={tb.successNoteHint}>
                <Textarea rows={3} value={editing.success_note ?? ""} onChange={(e) => setEditing({ ...editing, success_note: e.target.value })} />
              </Field>
              <Field label={tb.successNoteAr} hint={t.common.optional}>
                <Textarea dir="rtl" rows={3} value={editing.success_note_ar ?? ""} onChange={(e) => setEditing({ ...editing, success_note_ar: e.target.value })} />
              </Field>
            </div>

            <SectionRule label={tb.whatPatientsSee} />
            <div className="grid gap-3">
              <ToggleRow
                label={tb.showPrices}
                hint={tb.showPricesHint}
                checked={editing.show_prices !== false}
                onChange={(v) => setEditing({ ...editing, show_prices: v })}
              />
              <ToggleRow
                label={tb.allowAnyDoctor}
                hint={tb.allowAnyDoctorHint}
                checked={editing.allow_any_doctor !== false}
                onChange={(v) => setEditing({ ...editing, allow_any_doctor: v })}
              />
              <ToggleRow
                label={tb.requireConsent}
                hint={tb.requireConsentHint}
                checked={!!editing.require_consent}
                onChange={(v) => setEditing({ ...editing, require_consent: v })}
              />
            </div>
            {editing.require_consent && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tb.consentText} required>
                  <Textarea rows={3} value={editing.consent_text ?? ""} onChange={(e) => setEditing({ ...editing, consent_text: e.target.value })} />
                </Field>
                <Field label={tb.consentTextAr}>
                  <Textarea dir="rtl" rows={3} value={editing.consent_text_ar ?? ""} onChange={(e) => setEditing({ ...editing, consent_text_ar: e.target.value })} />
                </Field>
              </div>
            )}

            <label className="flex items-center gap-2.5">
              <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} />
              <span className="text-[13px] font-medium">{t.common.active}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
              <Button onClick={save} loading={pending} disabled={!editing.slug || !editing.name}>
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* --------------------------------------------------- question editor */}
      <Modal
        open={!!question}
        onClose={() => setQuestion(null)}
        title={question?.id ? t.common.edit : tb.addQuestion}
        wide
      >
        {question && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tb.questionLabel} required>
                <Input
                  value={question.label ?? ""}
                  onChange={(e) => setQuestion({ ...question, label: e.target.value })}
                />
              </Field>
              <Field label={tb.questionLabelAr} hint={t.common.optional}>
                <Input
                  dir="rtl"
                  value={question.label_ar ?? ""}
                  onChange={(e) => setQuestion({ ...question, label_ar: e.target.value })}
                />
              </Field>
              <Field label={tb.questionHelp} hint={tb.questionHelpHint}>
                <Input
                  value={question.help ?? ""}
                  onChange={(e) => setQuestion({ ...question, help: e.target.value })}
                />
              </Field>
              <Field label={tb.questionHelpAr} hint={t.common.optional}>
                <Input
                  dir="rtl"
                  value={question.help_ar ?? ""}
                  onChange={(e) => setQuestion({ ...question, help_ar: e.target.value })}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tb.answerType}>
                <Select
                  value={question.field_type ?? "text"}
                  onChange={(e) =>
                    setQuestion({ ...question, field_type: e.target.value as QuestionType })
                  }
                >
                  {QUESTION_TYPES.map((ft) => (
                    <option key={ft} value={ft}>
                      {tb.types[ft]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tb.askOn}>
                <Select
                  value={question.booking_link_id ?? ""}
                  onChange={(e) =>
                    setQuestion({ ...question, booking_link_id: e.target.value || null })
                  }
                >
                  <option value="">{tb.allLinks}</option>
                  {links.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {needsOptions && (
              <Field label={tb.options} hint={tb.optionsHint}>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Textarea
                    rows={4}
                    dir="ltr"
                    value={(question.options ?? []).join("\n")}
                    onChange={(e) =>
                      setQuestion({ ...question, options: e.target.value.split("\n") })
                    }
                  />
                  <Textarea
                    rows={4}
                    dir="rtl"
                    placeholder={tb.optionsArPlaceholder}
                    value={(question.options_ar ?? []).join("\n")}
                    onChange={(e) =>
                      setQuestion({ ...question, options_ar: e.target.value.split("\n") })
                    }
                  />
                </div>
              </Field>
            )}

            <Field label={tb.onlyForServices} hint={tb.onlyForServicesHint}>
              <div className="flex flex-wrap gap-2">
                {services.map((s) => {
                  const on = (question.service_ids ?? []).includes(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() =>
                        setQuestion({
                          ...question,
                          service_ids: on
                            ? (question.service_ids ?? []).filter((x) => x !== s.id)
                            : [...(question.service_ids ?? []), s.id],
                        })
                      }
                      className={`rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                        on ? "border-brand-500 bg-brand-50 text-brand-800" : "border-line-strong text-ink-500"
                      }`}
                    >
                      {serviceName(s)}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label={tb.savesTo} hint={tb.savesToHint}>
              <Select
                value={question.patient_field_key ?? ""}
                onChange={(e) =>
                  setQuestion({ ...question, patient_field_key: e.target.value || null })
                }
              >
                <option value="">{tb.appointmentOnly}</option>
                {patientFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {locale === "ar" ? f.label_ar || f.label : f.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-3">
              <ToggleRow
                label={tb.required}
                hint={tb.requiredHint}
                checked={!!question.required}
                onChange={(v) => setQuestion({ ...question, required: v })}
              />
              <ToggleRow
                label={t.common.active}
                hint={tb.questionActiveHint}
                checked={question.active !== false}
                onChange={(v) => setQuestion({ ...question, active: v })}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setQuestion(null)}>
                {t.common.cancel}
              </Button>
              <Button onClick={saveQuestion} loading={pending} disabled={!question.label?.trim()}>
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ------------------------------------------- pick a patient field */}
      <Modal open={pickField} onClose={() => setPickField(false)} title={tb.fromPatientFields}>
        <p className="mb-3 text-[13px] text-ink-500">{tb.fromPatientFieldsHint}</p>
        <ul className="divide-y divide-line">
          {patientFields.map((f) => {
            // A field already asked on this page is not offered twice.
            const used = questions.some((q) => q.patient_field_key === f.key);
            return (
              <li key={f.key} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {locale === "ar" ? f.label_ar || f.label : f.label}
                  </div>
                  <div className="text-[12px] text-ink-500">
                    {tb.types[(f.field_type as QuestionType) ?? "text"] ?? f.field_type}
                  </div>
                </div>
                {used ? (
                  <Badge status="neutral">{tb.alreadyAsked}</Badge>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      /*
                        Prefilled from the definition, then fully editable. The
                        wording a clinic uses on its own file is not always the
                        wording it wants to put to a patient — "DOB" on the
                        profile, "Your date of birth" on the booking page.
                      */
                      setPickField(false);
                      setQuestion({
                        label: f.label,
                        label_ar: f.label_ar ?? "",
                        field_type: (QUESTION_TYPES as readonly string[]).includes(f.field_type)
                          ? (f.field_type as QuestionType)
                          : "text",
                        options: f.options ?? [],
                        options_ar: [],
                        service_ids: [],
                        required: false,
                        active: true,
                        booking_link_id: null,
                        patient_field_key: f.key,
                      });
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {tb.addQuestion}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Modal>

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t.common.confirmDeleteTitle}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteId) {
            await deleteBookingLinkAction(slug, deleteId);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />

      <ConfirmDialog
        open={!!deleteQuestion}
        onClose={() => setDeleteQuestion(null)}
        title={t.common.confirmDeleteTitle}
        body={tb.deleteQuestionBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteQuestion) {
            await deleteBookingQuestionAction(slug, deleteQuestion.id);
            setDeleteQuestion(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

function SectionRule({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="border-t border-line pt-4">
      <div className="text-[13px] font-semibold text-ink-900">{label}</div>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}
