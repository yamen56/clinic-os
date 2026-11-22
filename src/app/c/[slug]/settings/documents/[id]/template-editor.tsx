"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { RichText, insertTokenAtCaret } from "@/components/esign/rich-text";
import { ServiceChips } from "@/components/ui/service-picker";
import type { SectionRow, ServiceRow } from "@/lib/services";
import { saveTemplateAction } from "../actions";
import { Plus, Trash2, Eye, Braces } from "lucide-react";
import { QUESTION_KINDS, QUESTIONS_AT, READY_QUESTIONS, normalizeQuestionsAt } from "@/lib/esign/questions";

type Def = {
  key: string;
  label: string;
  label_ar: string | null;
  scope: "patient" | "context";
};
type Role = { key: string; label: string; label_ar: string | null; is_staff: boolean };

type ExtraField = {
  key: string;
  label: string;
  label_ar: string;
  type: string;
  required: boolean;
  options: string[];
  roles: string[];
};
type SignerCfg = { role_key: string; required: boolean; order: number };

/**
 * The next free question key. Counting the questions was not enough: delete
 * the first of two and the next one added is `q2` again, and two questions
 * sharing a key share one answer — the second silently overwrites the first,
 * on a screen that never shows the key at all.
 */
function nextQuestionKey(taken: { key: string }[]): string {
  const used = new Set(taken.map((f) => f.key));
  for (let n = taken.length + 1; ; n++) if (!used.has(`q${n}`)) return `q${n}`;
}

/**
 * A signature box placed on an uploaded PDF, in page fractions rather than
 * pixels. Declared here rather than imported: the placer that created these
 * is gone, but existing templates still carry boxes and this editor still has
 * to round-trip them on save without moving anything.
 */
type PlacedField = {
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  field_type: "signature" | "initials" | "date" | "text" | "checkbox";
  assigned_role_key: string;
  is_required: boolean;
  label: string;
  prefilled_value: string | null;
  sort: number;
};
export function TemplateEditor({
  slug,
  isOwner,
  defs,
  roles,
  services,
  sections,
  template,
  versions,
  placedFields,
}: {
  slug: string;
  isOwner: boolean;
  /** Arrived from "import a file" — open the picker rather than a blank page. */
  defs: Def[];
  roles: Role[];
  services: ServiceRow[];
  sections: SectionRow[];
  template: Record<string, unknown> | null;
  versions: { version: number; name: string; created_at: string; author: string | null }[];
  placedFields: PlacedField[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();

  // Every new template is written here; "upload" only ever comes off an
  // existing row, from before that path was withdrawn.
  const source = (template?.source as string) ?? "template";
  const isUpload = source === "upload";

  const [name, setName] = useState((template?.name as string) ?? "");
  const [nameAr, setNameAr] = useState((template?.name_ar as string) ?? "");
  const [category, setCategory] = useState((template?.category as string) ?? "consent");
  const [language, setLanguage] = useState((template?.language as string) ?? "both");
  const [body, setBody] = useState((template?.body as string) ?? "");
  const [bodyAr, setBodyAr] = useState((template?.body_ar as string) ?? "");
  const [isActive, setIsActive] = useState(template ? !!template.is_active : true);
  const [serviceIds, setServiceIds] = useState<string[]>(
    (template?.serviceIds as string[]) ?? []
  );
  const [autoSend, setAutoSend] = useState(template ? !!template.autoSend : true);
  // Everyone signs at once (2026-11-21); there is no order to choose.
  const mode = "parallel" as const;
  const [signers, setSigners] = useState<SignerCfg[]>(
    ((template?.signer_config as { signers?: SignerCfg[] })?.signers ?? [
      { role_key: "patient", required: true, order: 0 },
    ]).map((s, i) => ({ ...s, order: s.order ?? i }))
  );
  // Older rows may predate a field, so every optional key gets a default.
  const [extras, setExtras] = useState<ExtraField[]>(
    ((template?.fields_schema as Partial<ExtraField>[]) ?? []).map((f) => ({
      key: f.key ?? "q",
      label: f.label ?? "",
      label_ar: f.label_ar ?? "",
      type: f.type ?? "text",
      required: f.required ?? false,
      options: f.options ?? [],
      roles: f.roles ?? [],
    }))
  );
  // When the patient answers: before reading, with the text, or after it.
  const [questionsAt, setQuestionsAt] = useState(normalizeQuestionsAt(template?.questions_at));
  const [tab, setTab] = useState<"ar" | "en">(language === "en" ? "en" : "ar");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // An uploaded template's file and boxes are read-only now (the upload was
  // withdrawn), so they are saved back exactly as they came.
  const fields = placedFields;
  const pdfPath = (template?.source_pdf_path as string | null) ?? null;

  const roleLabel = (key: string) => {
    const r = roles.find((x) => x.key === key);
    if (!r) return key;
    return locale === "ar" ? r.label_ar || r.label : r.label;
  };

  const currentBody = tab === "ar" ? bodyAr : body;
  const setCurrentBody = tab === "ar" ? setBodyAr : setBody;

  const previewHtml = useMemo(() => {
    // Tokens are shown as their own labels so staff read the shape of the
    // document rather than a wall of braces.
    return currentBody.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
      const d = defs.find((x) => x.key === key);
      const label = d ? (locale === "ar" ? d.label_ar || d.label : d.label) : key;
      return `<span class="doc-override">${label}</span>`;
    });
  }, [currentBody, defs, locale]);

  const save = () =>
    start(async () => {
      if (!name.trim()) {
        toast(t.docTemplates.errors.nameRequired, "error");
        return;
      }
      if (!isUpload && !body.trim() && !bodyAr.trim()) {
        toast(t.docTemplates.errors.bodyRequired, "error");
        return;
      }
      if (isUpload && !pdfPath) {
        toast(t.docTemplates.errors.badPdf, "error");
        return;
      }
      if (!signers.length) {
        toast(t.docTemplates.errors.signerRequired, "error");
        return;
      }
      /*
        A question added and left blank used to fail on the server as a plain
        "invalid", which the editor could only show as "something went wrong" —
        and the whole template was lost, with nothing pointing at the empty
        question that caused it. Caught here instead, and the question is named.
      */
      const blank = extras.findIndex((f) => !f.label.trim() && !f.label_ar.trim());
      if (blank >= 0) {
        toast(t.docTemplates.errors.fieldLabelRequired.replace("{n}", String(blank + 1)), "error");
        return;
      }
      // A "choose" question with nothing to choose from would reach the patient as an empty list.
      const noChoices = extras.findIndex(
        (f) => (f.type === "select" || f.type === "choices") && !f.options.some((o) => o.trim())
      );
      if (noChoices >= 0) {
        toast(t.docTemplates.errors.choicesRequired.replace("{n}", String(noChoices + 1)), "error");
        return;
      }
      const r = await saveTemplateAction(slug, {
        id: (template?.id as string) ?? undefined,
        name: name.trim(),
        nameAr: nameAr.trim(),
        category,
        language,
        body,
        bodyAr,
        signerConfig: { mode, signers },
        fieldsSchema: extras,
        questionsAt,
        isActive,
        serviceIds,
        autoSend,
        source,
        sourcePdfPath: pdfPath,
        placedFields: fields,
      });
      if (r.error) {
        toast(
          (t.docTemplates.errors as Record<string, string>)[r.error] ?? t.common.genericError,
          "error"
        );
        return;
      }
      toast(t.docTemplates.saved);
      if (!template?.id && r.id) {
        router.replace(`/c/${slug}/settings/documents/${r.id}`);
      }
    });

  return (
    <div className="grid gap-4">
      <PageHeader
        title={
          template ? name || t.docTemplates.title : t.docTemplates.addTemplate
        }
        sub={
          template
            ? `${t.docTemplates.version.replace("{n}", String(template.version))} · ${t.docTemplates.versionHint}`
            : undefined
        }
        action={
          <>
            {!isUpload && (
              <Button variant="outline" onClick={() => setPreviewOpen(true)}>
                <Eye className="h-4 w-4" />
                {t.docTemplates.previewAs} {tab === "ar" ? t.common.arabic : t.common.english}
              </Button>
            )}
            {versions.length > 0 && (
              <Button variant="ghost" onClick={() => setVersionsOpen(true)}>
                {t.docTemplates.versionHistory}
              </Button>
            )}
            <Button onClick={save} loading={pending}>
              {t.common.save}
            </Button>
          </>
        }
      />

      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.docTemplates.name} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t.docTemplates.nameAr}>
            <Input dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </Field>
          <Field label={t.docTemplates.category}>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(t.docTemplates.categories).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.docTemplates.language}>
            <Select
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                if (e.target.value === "en") setTab("en");
                if (e.target.value === "ar") setTab("ar");
              }}
            >
              {Object.entries(t.docTemplates.languages).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[0.8125rem] font-medium">{t.docTemplates.active}</span>
          <Toggle checked={isActive} onChange={setIsActive} label={t.docTemplates.active} />
        </label>
      </Card>

      {/*
        A template built from an uploaded PDF can still be opened, renamed and
        switched off — a few were made before that path was withdrawn, and the
        documents signed from them are records. What is gone is making a new
        one: the upload and the Word/PDF import never converted reliably, and a
        consent form that comes out wrong is worse than one you have to type.
      */}
      {isUpload && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[0.8125rem] font-semibold">{t.docTemplates.uploadedPdf}</div>
              <p className="mt-0.5 text-[0.75rem] text-ink-500">{t.docTemplates.uploadedPdfHint}</p>
            </div>
            {pdfPath && (
              <a
                href={`/api/c/${slug}/documents/template-pdf?path=${encodeURIComponent(pdfPath)}`}
                target="_blank"
                rel="noreferrer"
                className={buttonClass({ variant: "outline", size: "sm" })}
              >
                {t.docTemplates.openPdf}
              </a>
            )}
          </div>
        </Card>
      )}

      {!isUpload && (
        <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
          <Card className="p-5">
            {language === "both" && (
              <div className="mb-3">
                <Tabs
                  tabs={[
                    { key: "ar", label: t.common.arabic },
                    { key: "en", label: t.common.english },
                  ]}
                  active={tab}
                  onChange={(k) => setTab(k as "ar" | "en")}
                />
              </div>
            )}
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[0.8125rem] font-semibold">
                {tab === "ar" ? t.docTemplates.bodyAr : t.docTemplates.bodyEn}
              </span>
            </div>
            <RichText
              key={tab}
              defaultValue={currentBody}
              dir={tab === "ar" ? "rtl" : "ltr"}
              placeholder={tab === "ar" ? t.docTemplates.bodyAr : t.docTemplates.bodyEn}
              onChange={setCurrentBody}
            />
            <p className="mt-2 text-[0.75rem] text-ink-500">{t.docTemplates.bodyHint}</p>
          </Card>

          <Card className="h-fit p-4">
            <h3 className="flex items-center gap-2 text-[0.8125rem] font-semibold">
              <Braces className="h-4 w-4 text-ink-400" />
              {t.docTemplates.variables}
            </h3>
            <p className="mt-1 text-[0.75rem] text-ink-500">{t.docTemplates.variablesSub}</p>
            <div className="mt-3 grid max-h-96 gap-1 overflow-y-auto">
              {(["patient", "context"] as const).map((scope) => (
                <div key={scope}>
                  <div className="mb-1 mt-2 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">
                    {scope === "patient" ? t.fields.onRecord : t.fields.fromContext}
                  </div>
                  {defs
                    .filter((d) => d.scope === scope)
                    .map((d) => (
                      <button
                        key={d.key}
                        type="button"
                        // Mouse-down keeps the editor's selection alive.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          if (!insertTokenAtCaret(d.key)) {
                            void navigator.clipboard.writeText(`{{${d.key}}}`);
                            toast(t.fields.copied);
                            return;
                          }
                          setCurrentBody(
                            document.querySelector<HTMLElement>(".doc-editor")?.innerHTML ??
                              currentBody
                          );
                        }}
                        className="block w-full rounded-md px-2 py-1 text-start text-[0.75rem] transition-colors hover:bg-brand-50"
                      >
                        {locale === "ar" ? d.label_ar || d.label : d.label}
                      </button>
                    ))}
                </div>
              ))}
            </div>
            <Link
              href={`/c/${slug}/settings/fields`}
              className="mt-3 block text-[0.75rem] font-medium text-brand-700 hover:underline"
            >
              {t.docTemplates.manageVariables}
            </Link>
          </Card>
        </div>
      )}

      {/* --------------------------------------------------------- signers */}
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-[0.9375rem] font-semibold">{t.docTemplates.signerSetup}</h2>
          <p className="mt-0.5 text-[0.8125rem] text-ink-500">{t.docTemplates.signerSetupSub}</p>
        </div>
        <div className="grid gap-3 p-5">
          <p className="text-[0.8125rem] text-ink-500">{t.docTemplates.signersAtOnce}</p>

          <div className="grid gap-2">
            {signers.map((s, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
              >
                <Select
                  className="!w-auto min-w-40 flex-1"
                  value={s.role_key}
                  onChange={(e) =>
                    setSigners(
                      signers.map((x, idx) => (idx === i ? { ...x, role_key: e.target.value } : x))
                    )
                  }
                >
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {roleLabel(r.key)}
                    </option>
                  ))}
                </Select>
                <label className="flex items-center gap-2 text-[0.75rem]">
                  <Toggle
                    checked={s.required}
                    label={t.docs.requiredSigner}
                    onChange={(v) =>
                      setSigners(signers.map((x, idx) => (idx === i ? { ...x, required: v } : x)))
                    }
                  />
                  {s.required ? t.docs.requiredSigner : t.docs.optionalSigner}
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.docs.removeSigner}
                  onClick={() =>
                    setSigners(signers.filter((_, idx) => idx !== i).map((x, idx) => ({ ...x, order: idx })))
                  }
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() =>
              setSigners([
                ...signers,
                {
                  role_key: roles.find((r) => !signers.some((s) => s.role_key === r.key))?.key ?? "witness",
                  required: true,
                  order: signers.length,
                },
              ])
            }
          >
            <Plus className="h-4 w-4" />
            {t.docs.addSigner}
          </Button>
        </div>
      </Card>

      {/* ---------------------------------------------------- extra questions */}
      {/*
        Questions at signing (2026-11-22), modelled on a clinic's paper intake
        form: pick a ready question in one tap or write your own; four kinds
        only; asked of the patient unless you say otherwise. They used to be
        asked of every signer (a doctor got "are you allergic?"), and a
        "choose" question had nowhere to type its choices.
      */}
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-[0.9375rem] font-semibold">{t.docTemplates.extraFields}</h2>
          <p className="mt-0.5 text-[0.8125rem] text-ink-500">{t.docTemplates.extraFieldsSub}</p>
        </div>
        <div className="grid gap-3 p-5">
          {/* Some clinics ask before the patient reads, some beside the text; most after it. */}
          {extras.length > 0 && (
            <div className="grid gap-1.5">
              <span className="text-[0.75rem] font-semibold text-ink-500">{t.docTemplates.questionsAt}</span>
              <div
                role="radiogroup"
                aria-label={t.docTemplates.questionsAt}
                className="grid grid-cols-3 gap-0.5 rounded-ctl bg-ink-900/5 p-0.5 sm:max-w-md"
                data-questions-at={questionsAt}
              >
                {QUESTIONS_AT.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={questionsAt === k}
                    onClick={() => setQuestionsAt(k)}
                    data-at={k}
                    className={`min-h-10 touch-manipulation rounded-md px-2 text-[0.8125rem] font-semibold transition-colors duration-140 ease-out ${
                      questionsAt === k ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
                    }`}
                  >
                    {t.docTemplates.questionsAtKinds[k]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {READY_QUESTIONS.some((r) => !extras.some((x) => x.label === r.label || x.label_ar === r.label_ar)) && (
            <div className="flex flex-wrap items-center gap-1.5" data-ready-questions>
              <span className="me-1 text-[0.75rem] font-semibold text-ink-500">{t.docTemplates.readyQuestions}</span>
              {READY_QUESTIONS.filter((r) => !extras.some((x) => x.label === r.label || x.label_ar === r.label_ar)).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() =>
                    setExtras([
                      ...extras,
                      { key: nextQuestionKey(extras), label: r.label, label_ar: r.label_ar, type: r.type, required: true, options: [], roles: ["patient"] },
                    ])
                  }
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-line bg-surface px-3 text-[0.75rem] font-medium text-ink-700 transition-colors hover:border-brand-400 hover:bg-brand-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {locale === "ar" ? r.label_ar : r.label}
                </button>
              ))}
            </div>
          )}

          {extras.map((f, i) => {
            const set = (patch: Partial<ExtraField>) => setExtras(extras.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
            const kinds: string[] = (QUESTION_KINDS as readonly string[]).includes(f.type) ? [...QUESTION_KINDS] : [...QUESTION_KINDS, f.type];
            return (
              <div key={f.key} className="grid gap-3 rounded-lg border border-line p-3" data-question-row>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t.docTemplates.extraLabel + " (AR)"}>
                    <Input dir="rtl" value={f.label_ar} onChange={(e) => set({ label_ar: e.target.value })} />
                  </Field>
                  <Field label={t.docTemplates.extraLabel + " (EN)"}>
                    <Input dir="ltr" value={f.label} onChange={(e) => set({ label: e.target.value })} />
                  </Field>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t.fields.type}>
                    <Select className="!w-auto min-w-40" value={f.type} onChange={(e) => set({ type: e.target.value })}>
                      {kinds.map((k) => (
                        <option key={k} value={k}>
                          {(t.docTemplates.kinds as Record<string, string>)[k] ?? (t.fields.types as Record<string, string>)[k] ?? k}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t.docTemplates.askedOf}>
                    <Select
                      className="!w-auto min-w-36"
                      value={f.roles[0] ?? ""}
                      onChange={(e) => set({ roles: e.target.value ? [e.target.value] : [] })}
                    >
                      <option value="">{t.docTemplates.everyone}</option>
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>
                          {roleLabel(r.key)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <label className="flex min-h-10 items-center gap-2 text-[0.8125rem]">
                    <Toggle checked={f.required} label={t.docTemplates.mustAnswer} onChange={(v) => set({ required: v })} />
                    {t.docTemplates.mustAnswer}
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ms-auto"
                    aria-label={t.common.delete}
                    onClick={() => setExtras(extras.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                </div>
                {(f.type === "select" || f.type === "choices") && (
                  <Field label={t.docTemplates.choicesLabel}>
                    <Textarea
                      rows={3}
                      value={f.options.join("\n")}
                      onChange={(e) => set({ options: e.target.value.split("\n").map((o) => o.trimStart()) })}
                      onBlur={() => set({ options: f.options.map((o) => o.trim()).filter(Boolean) })}
                    />
                  </Field>
                )}
              </div>
            );
          })}

          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() =>
              setExtras([
                ...extras,
                { key: nextQuestionKey(extras), label: "", label_ar: "", type: "yes_no", required: true, options: [], roles: ["patient"] },
              ])
            }
          >
            <Plus className="h-4 w-4" />
            {t.docTemplates.writeOwn}
          </Button>
        </div>
      </Card>

      {/* -------------------------------------------------- attached services */}
      {services.length > 0 && (
        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-[0.9375rem] font-semibold">{t.docTemplates.attachedServices}</h2>
            <p className="mt-0.5 text-[0.8125rem] text-ink-500">{t.docTemplates.attachedServicesSub}</p>
          </div>
          <div className="grid gap-2 p-5">
            <ServiceChips
              services={services}
              sections={sections}
              selected={serviceIds}
              onToggle={(id) =>
                setServiceIds(
                  serviceIds.includes(id)
                    ? serviceIds.filter((x) => x !== id)
                    : [...serviceIds, id]
                )
              }
            />
            {serviceIds.length > 0 && (
              <label className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[0.8125rem] font-medium">{t.docTemplates.autoSend}</span>
                <Toggle checked={autoSend} onChange={setAutoSend} label={t.docTemplates.autoSend} />
              </label>
            )}
          </div>
        </Card>
      )}

      {!isOwner && (
        <p className="text-[0.75rem] text-ink-400">{t.docs.errors.forbidden}</p>
      )}

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title={t.docTemplates.previewAs} wide>
        <div
          dir={tab === "ar" ? "rtl" : "ltr"}
          className="doc-body-wrap rounded-card border border-line bg-surface p-6 text-sm leading-relaxed"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </Modal>

      <Modal open={versionsOpen} onClose={() => setVersionsOpen(false)} title={t.docTemplates.versionHistory}>
        <ul className="divide-y divide-line">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="flex items-center gap-2">
                <Badge status={v.version === template?.version ? "brand" : "neutral"}>
                  {t.docTemplates.version.replace("{n}", String(v.version))}
                </Badge>
                {v.name}
              </span>
              <span className="text-[0.75rem] text-ink-400">
                {fmtDateTime(v.created_at, "UTC", locale)}
                {v.author ? ` · ${v.author}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[0.75rem] text-ink-500">{t.docTemplates.versionHint}</p>
      </Modal>
    </div>
  );
}
