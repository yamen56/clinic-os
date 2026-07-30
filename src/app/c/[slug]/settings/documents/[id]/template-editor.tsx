"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { RichText, insertTokenAtCaret } from "@/components/esign/rich-text";
import { ImportFileButton } from "@/components/esign/import-file";
import { PdfFieldPlacer, type PlacedField } from "@/components/esign/pdf-field-placer";
import { saveTemplateAction } from "../actions";
import { ArrowLeft, Plus, Trash2, Eye, Braces, ChevronUp, ChevronDown } from "lucide-react";

type Def = {
  key: string;
  label: string;
  label_ar: string | null;
  scope: "patient" | "context";
};
type Role = { key: string; label: string; label_ar: string | null; is_staff: boolean };
type Service = { id: string; name: string; name_ar: string | null };
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

export function TemplateEditor({
  slug,
  isOwner,
  defaultSource,
  autoImport,
  defs,
  roles,
  services,
  template,
  versions,
  placedFields,
}: {
  slug: string;
  isOwner: boolean;
  defaultSource: "template" | "upload";
  /** Arrived from "import a file" — open the picker rather than a blank page. */
  autoImport?: boolean;
  defs: Def[];
  roles: Role[];
  services: Service[];
  template: Record<string, unknown> | null;
  versions: { version: number; name: string; created_at: string; author: string | null }[];
  placedFields: PlacedField[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();

  const source = (template?.source as string) ?? defaultSource;
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
  const [mode, setMode] = useState<"sequential" | "parallel">(
    ((template?.signer_config as { mode?: string })?.mode as "sequential" | "parallel") ?? "sequential"
  );
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
  const [tab, setTab] = useState<"ar" | "en">(language === "en" ? "en" : "ar");
  const [imported, setImported] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [fields, setFields] = useState<PlacedField[]>(placedFields);
  const [pdfPath, setPdfPath] = useState<string | null>(
    (template?.source_pdf_path as string | null) ?? null
  );

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
      } else {
        router.refresh();
      }
    });

  const moveSigner = (i: number, dir: -1 | 1) => {
    const next = [...signers];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setSigners(next.map((s, idx) => ({ ...s, order: idx })));
  };

  return (
    <div className="grid gap-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link href={`/c/${slug}/settings/documents`} aria-label={t.common.back}>
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
              </Button>
            </Link>
            {template ? name || t.docTemplates.title : t.docTemplates.addTemplate}
          </span>
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
          <span className="text-[13px] font-medium">{t.docTemplates.active}</span>
          <Toggle checked={isActive} onChange={setIsActive} label={t.docTemplates.active} />
        </label>
      </Card>

      {isUpload ? (
        <PdfFieldPlacer
          slug={slug}
          templateId={(template?.id as string) ?? null}
          pdfPath={pdfPath}
          onPdfPathChange={setPdfPath}
          roles={roles}
          fields={fields}
          onFieldsChange={setFields}
        />
      ) : (
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
              <span className="text-[13px] font-semibold">
                {tab === "ar" ? t.docTemplates.bodyAr : t.docTemplates.bodyEn}
              </span>
              {/*
                Bumping `imported` remounts RichText, which is uncontrolled and
                reads its content from `defaultValue` once. Without it the state
                would hold the imported body while the editor still showed the
                old one.
              */}
              <ImportFileButton
                slug={slug}
                dir={tab === "ar" ? "rtl" : "ltr"}
                autoOpen={autoImport && !template}
                onInsert={(html) => {
                  setCurrentBody(html);
                  setImported((n) => n + 1);
                }}
              />
            </div>
            <RichText
              key={`${tab}-${imported}`}
              defaultValue={currentBody}
              dir={tab === "ar" ? "rtl" : "ltr"}
              placeholder={tab === "ar" ? t.docTemplates.bodyAr : t.docTemplates.bodyEn}
              onChange={setCurrentBody}
            />
            <p className="mt-2 text-[12px] text-ink-500">{t.docTemplates.bodyHint}</p>
          </Card>

          <Card className="h-fit p-4">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              <Braces className="h-4 w-4 text-ink-400" />
              {t.docTemplates.variables}
            </h3>
            <p className="mt-1 text-[12px] text-ink-500">{t.docTemplates.variablesSub}</p>
            <div className="mt-3 grid max-h-96 gap-1 overflow-y-auto">
              {(["patient", "context"] as const).map((scope) => (
                <div key={scope}>
                  <div className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
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
                        className="block w-full rounded-md px-2 py-1 text-start text-[12px] transition-colors hover:bg-brand-50"
                      >
                        {locale === "ar" ? d.label_ar || d.label : d.label}
                      </button>
                    ))}
                </div>
              ))}
            </div>
            <Link
              href={`/c/${slug}/settings/fields`}
              className="mt-3 block text-[12px] font-medium text-brand-700 hover:underline"
            >
              {t.docTemplates.manageVariables}
            </Link>
          </Card>
        </div>
      )}

      {/* --------------------------------------------------------- signers */}
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold">{t.docTemplates.signerSetup}</h2>
          <p className="mt-0.5 text-[13px] text-ink-500">{t.docTemplates.signerSetupSub}</p>
        </div>
        <div className="grid gap-3 p-5">
          <Field label={t.docs.signingOrder} hint={mode === "sequential" ? t.docs.sequentialHint : t.docs.parallelHint}>
            <Select value={mode} onChange={(e) => setMode(e.target.value as "sequential" | "parallel")}>
              <option value="sequential">{t.docs.sequential}</option>
              <option value="parallel">{t.docs.parallel}</option>
            </Select>
          </Field>

          <div className="grid gap-2">
            {signers.map((s, i) => (
              <div
                key={i}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
              >
                {mode === "sequential" && (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-700 tnum">
                    {i + 1}
                  </span>
                )}
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
                <label className="flex items-center gap-2 text-[12px]">
                  <Toggle
                    checked={s.required}
                    label={t.docs.requiredSigner}
                    onChange={(v) =>
                      setSigners(signers.map((x, idx) => (idx === i ? { ...x, required: v } : x)))
                    }
                  />
                  {s.required ? t.docs.requiredSigner : t.docs.optionalSigner}
                </label>
                {mode === "sequential" && (
                  <div className="flex flex-col">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => moveSigner(i, -1)}
                      aria-label={t.fields.moveUp}
                      className="text-ink-300 hover:text-ink-700 disabled:opacity-30"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      disabled={i === signers.length - 1}
                      onClick={() => moveSigner(i, 1)}
                      aria-label={t.fields.moveDown}
                      className="text-ink-300 hover:text-ink-700 disabled:opacity-30"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </div>
                )}
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
      <Card>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{t.docTemplates.extraFields}</h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t.docTemplates.extraFieldsSub}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setExtras([
                ...extras,
                {
                  key: `q${extras.length + 1}`,
                  label: "",
                  label_ar: "",
                  type: "text",
                  required: false,
                  options: [],
                  roles: [],
                },
              ])
            }
          >
            <Plus className="h-4 w-4" />
            {t.docTemplates.addExtraField}
          </Button>
        </div>
        {extras.length > 0 && (
          <div className="grid gap-3 p-5">
            {extras.map((f, i) => (
              <div key={i} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-[1fr_1fr_9rem_auto]">
                <Field label={t.docTemplates.extraLabel}>
                  <Input
                    value={f.label}
                    onChange={(e) =>
                      setExtras(extras.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))
                    }
                  />
                </Field>
                <Field label={t.docTemplates.extraLabel + " (AR)"}>
                  <Input
                    dir="rtl"
                    value={f.label_ar}
                    onChange={(e) =>
                      setExtras(extras.map((x, idx) => (idx === i ? { ...x, label_ar: e.target.value } : x)))
                    }
                  />
                </Field>
                <Field label={t.fields.type}>
                  <Select
                    value={f.type}
                    onChange={(e) =>
                      setExtras(extras.map((x, idx) => (idx === i ? { ...x, type: e.target.value } : x)))
                    }
                  >
                    {(["text", "longtext", "number", "date", "select", "checkbox"] as const).map((k) => (
                      <option key={k} value={k}>
                        {(t.fields.types as Record<string, string>)[k]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end gap-2 pb-1">
                  <Toggle
                    checked={f.required}
                    label={t.docs.requiredSigner}
                    onChange={(v) =>
                      setExtras(extras.map((x, idx) => (idx === i ? { ...x, required: v } : x)))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.common.delete}
                    onClick={() => setExtras(extras.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* -------------------------------------------------- attached services */}
      {services.length > 0 && (
        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-[15px] font-semibold">{t.docTemplates.attachedServices}</h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t.docTemplates.attachedServicesSub}</p>
          </div>
          <div className="grid gap-2 p-5">
            <div className="flex flex-wrap gap-1.5">
              {services.map((s) => {
                const on = serviceIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() =>
                      setServiceIds(on ? serviceIds.filter((x) => x !== s.id) : [...serviceIds, s.id])
                    }
                    className={`rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                      on
                        ? "border-brand-500 bg-brand-50 text-brand-800"
                        : "border-line text-ink-700 hover:bg-sunken"
                    }`}
                  >
                    {locale === "ar" ? s.name_ar || s.name : s.name}
                  </button>
                );
              })}
            </div>
            {serviceIds.length > 0 && (
              <label className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium">{t.docTemplates.autoSend}</span>
                <Toggle checked={autoSend} onChange={setAutoSend} label={t.docTemplates.autoSend} />
              </label>
            )}
          </div>
        </Card>
      )}

      {!isOwner && (
        <p className="text-[12px] text-ink-400">{t.docs.errors.forbidden}</p>
      )}

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title={t.docTemplates.previewAs} wide>
        <div
          dir={tab === "ar" ? "rtl" : "ltr"}
          className="doc-body-wrap rounded-card border border-line bg-white p-6 text-sm leading-relaxed"
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
              <span className="text-[12px] text-ink-400">
                {fmtDateTime(v.created_at, "UTC", locale)}
                {v.author ? ` · ${v.author}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-ink-500">{t.docTemplates.versionHint}</p>
      </Modal>
    </div>
  );
}
