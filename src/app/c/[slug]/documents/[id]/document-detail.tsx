"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { Card, PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { PhoneInput } from "@/components/ui/phone-input";
import { FileField } from "@/components/ui/file-field";
import { countryFromClinic } from "@/lib/phone";
import { useToast } from "@/components/ui/toast";
import { DocumentBody } from "@/components/esign/document-body";
import { SignaturePad, type SignaturePadHandle } from "@/components/esign/signature-pad";
import { DOC_STATUS_BADGE } from "@/components/esign/status";
import { DownloadSignedPdf } from "@/components/esign/download-signed";
import { Menu, MenuItem } from "@/components/ui/menu";
import { buttonClass } from "@/components/ui/button-class";
import { SignersPanel, type StaffOption } from "./signers-panel";
import { QuestionInput } from "@/components/esign/question-input";
import {
  clearFieldValueAction,
  declineAsStaffAction,
  sendDocumentAction,
  setFieldValueAction,
  setSignersAction,
  signAsStaffAction,
  startInPersonAction,
  supersedeDocumentAction,
  voidDocumentAction,
  type SendActionResult,
} from "../actions";
import {
  Send,
  Tablet,
  Link2,
  Ban,
  ShieldAlert,
  ShieldCheck,
  Pencil,
  RotateCcw,
  Plus,
  Trash2,
  PenTool,
  Check,
  FileWarning,
  FileUp,
  MoreHorizontal,
  UserPen,
} from "lucide-react";

type Signer = {
  id: string;
  role_key: string;
  role_label: string | null;
  role_label_ar: string | null;
  is_staff: boolean;
  signing_order: number;
  is_required: boolean;
  display_name: string;
  phone_e164: string | null;
  user_id: string | null;
  relationship: string | null;
  status: string;
  link_opened_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  decline_reason: string | null;
  signed_in_person: boolean;
  signed_automatically?: boolean;
};

type Detail = {
  doc: {
    id: string;
    patient_id: string | null;
    patient_name: string | null;
    patient_phone: string | null;
    template_id: string | null;
    template_name: string | null;
    source: "template" | "upload";
    title: string;
    language: "ar" | "en";
    status: string;
    signing_mode: "sequential" | "parallel";
    content_snapshot: string | null;
    final_pdf_path: string | null;
    final_pdf_source: "generated" | "uploaded";
    content_hash: string | null;
    hash_ok: boolean;
    appointment_id: string | null;
    created_by_name: string | null;
    sent_at: string | null;
    completed_at: string | null;
    expires_at: string | null;
    void_reason: string | null;
    locked_by: string | null;
    locked_by_name: string | null;
    supersedes_document_id: string | null;
    created_at: string;
  };
  previewHtml: string;
  bodySource: string;
  signers: Signer[];
  dueSignerIds: string[];
  fields: {
    key: string;
    label: string;
    labelAr: string;
    value: string;
    isOverride: boolean;
    isOneOff: boolean;
    scope: string;
    fixHint: string | null;
    used: boolean;
  }[];
  missing: { key: string; label: string; fixHint: string | null; byPatient: boolean }[];
  events: {
    id: string;
    event_type: string;
    actor_name: string | null;
    ip_address: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  }[];
  roles: { key: string; label: string; label_ar: string | null; is_staff: boolean }[];
  extraQuestions: {
    key: string;
    label: string;
    label_ar: string;
    type: string;
    required: boolean;
    options: string[];
    roles: string[];
  }[];
};

export function DocumentDetailClient({
  slug,
  tz,
  canManage,
  canSendLink = true,
  canVoid,
  userId,
  hasSavedSignature,
  staff,
  autoOpenSignerId,
  detail,
}: {
  slug: string;
  tz: string;
  canManage: boolean;
  /** Signing links to a phone are in the plan (lib/plans `esign_remote`). */
  canSendLink?: boolean;
  canVoid: boolean;
  userId: string;
  hasSavedSignature: boolean;
  staff: StaffOption[];
  autoOpenSignerId: string | null;
  detail: Detail;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const { doc } = detail;

  const [tab, setTab] = useState<"document" | "values" | "audit">("document");
  const [overrideKey, setOverrideKey] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState("");
  const [oneOff, setOneOff] = useState<{ label: string; value: string } | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [sendResult, setSendResult] = useState<SendActionResult | null>(null);
  const [editSigners, setEditSigners] = useState<Signer[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [drawing, setDrawing] = useState(!hasSavedSignature);
  const padRef = useRef<SignaturePadHandle>(null);

  const isDraft = doc.status === "draft";
  const patientFills = detail.missing.filter((m) => m.byPatient);
  const blockingMissing = detail.missing.filter((m) => !m.byPatient);
  const isTerminal = ["completed", "declined", "expired", "voided"].includes(doc.status);
  /** Everyone required has signed — there is a final version to hand over. */
  const isCompleted = doc.status === "completed";
  const canSend = canManage && !isTerminal;
  const roleName = (s: { role_key: string; role_label: string | null; role_label_ar: string | null }) => {
    const fallback = (t.docs.roles as Record<string, string>)[s.role_key];
    if (locale === "ar") return s.role_label_ar || fallback || s.role_label || s.role_key;
    return s.role_label || fallback || s.role_key;
  };

  /** The signer row that is me, once the document is out and it is mine to sign. */
  const mySigner = useMemo(
    () =>
      isDraft
        ? null
        : (detail.signers.find(
            (s) => s.user_id === userId && s.status !== "signed" && detail.dueSignerIds.includes(s.id)
          ) ?? null),
    [detail.signers, detail.dueSignerIds, userId, isDraft]
  );

  useEffect(() => {
    if (autoOpenSignerId && mySigner?.id === autoOpenSignerId) setSignOpen(true);
  }, [autoOpenSignerId, mySigner]);

  const patientSigner = detail.signers.find((s) => s.role_key === "patient");
  const hasNoPhonePatient = !!patientSigner && !patientSigner.phone_e164;

  /* ---------------------------------------------------------------- actions */

  const send = (isResend = false) =>
    start(async () => {
      const r = await sendDocumentAction(slug, doc.id, { isResend });
      setSendResult(r);
      if (r.error) {
        toast(
          (t.docs.errors as Record<string, string>)[r.error] ?? t.common.genericError,
          "error"
        );
        if (r.error === "missing_fields") setTab("values");
        return;
      }
      if (r.delivered) toast(t.docs.sentOk);
      else if (r.staffNotified) toast(t.docs.sentToStaffOk);
    });

  const startInPerson = () =>
    start(async () => {
      const r = await startInPersonAction(slug, doc.id);
      if (r.error === "locked") {
        toast(t.docs.lockedBody.replace("{name}", r.heldBy ?? ""), "error");
        return;
      }
      if (r.error) {
        toast(
          (t.docs.errors as Record<string, string>)[r.error] ?? t.common.genericError,
          "error"
        );
        if (r.error === "missing_fields") setTab("values");
        return;
      }
      // Straight into the locked view — the whole point is that staff hand the
      // device over without navigating anywhere else first.
      router.push(`/sign-device/${slug}/${doc.id}/${r.signerId}`);
    });

  const signNow = () =>
    start(async () => {
      if (!mySigner) return;
      const value = drawing ? padRef.current?.value() : null;
      if (drawing && !value) {
        toast(t.docs.errors.bad_signature, "error");
        return;
      }
      const r = await signAsStaffAction(slug, {
        documentId: doc.id,
        signerId: mySigner.id,
        pngDataUrl: value?.png,
        svg: value?.svg ?? null,
        fieldAnswers: answers,
        saveForLater: true,
      });
      if (r.error) {
        toast(
          (t.docs.errors as Record<string, string>)[r.error] ?? t.common.genericError,
          "error"
        );
        return;
      }
      toast(t.docs.signed);
      setSignOpen(false);
    });

  const saveOverride = (key: string, label: string, labelAr: string, value: string) =>
    start(async () => {
      const r = await setFieldValueAction(slug, {
        documentId: doc.id,
        fieldKey: key,
        label,
        labelAr,
        value,
        isOneOff: false,
      });
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      setOverrideKey(null);
    });

  /* ------------------------------------------------------------------- view */

  const statusBadge = (DOC_STATUS_BADGE[doc.status] ?? "neutral") as StatusKey;

  return (
    /*
      grid-cols-1, so the column's floor is zero rather than the min-content
      width of the document inside it. A consent form with a wide table measured
      1316px here; the card grew to match, the header and tabs stretched with it,
      and the page reported itself 1382px wide on a 390px phone. The
      `overflow-x: auto` on .doc-body-wrap could not help — it only scrolls once
      something has constrained the element, and nothing had.
    */
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {doc.title}
            <Badge status={statusBadge}>
              {(t.docs.statuses as Record<string, string>)[doc.status] ?? doc.status}
            </Badge>
          </span>
        }
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {doc.patient_id && doc.patient_name && (
              <Link
                href={`/c/${slug}/patients/${doc.patient_id}`}
                className="font-medium text-brand-700 hover:underline"
              >
                {doc.patient_name}
              </Link>
            )}
            <span>
              {t.docs.createdOn}: {fmtDate(doc.created_at, tz, locale)}
              {doc.created_by_name ? ` · ${doc.created_by_name}` : ""}
            </span>
            {doc.expires_at && !isTerminal && (
              <span className="text-st-pending">
                {t.docs.expiresOn.replace("{date}", fmtDate(doc.expires_at, tz, locale))}
              </span>
            )}
          </span>
        }
        action={
          /*
            One button for the next step, everything else under More. It was up
            to six buttons in a row — sign, sign on this device, send, upload,
            download, void — and the one that mattered was never obvious.
          */
          <>
            {mySigner && (
              <Button onClick={() => setSignOpen(true)}>
                <PenTool className="h-4 w-4" />
                {t.docs.countersign}
              </Button>
            )}
            {canSend && canSendLink && isDraft && (
              <Button onClick={() => send(false)} loading={pending} data-send-document>
                <Send className="h-4 w-4" />
                {t.docs.sendForSignature}
              </Button>
            )}
            {/*
              The other way to get it signed, so it stays in sight: a patient
              at the desk is handed the tablet in four taps from their file.
            */}
            {canSend && (
              <Button variant="outline" onClick={startInPerson} loading={pending}>
                <Tablet className="h-4 w-4" />
                {t.docs.signOnThisDevice}
              </Button>
            )}
            {/*
              Offered whenever there is something finished to hand over, which
              is not the same as "a file is already stored". The render happens
              when the last signature lands, so a document that completed a
              moment ago — or while the worker was down — has no path yet and
              used to show no button at all, which read as the feature being
              missing rather than a few seconds late.
            */}
            {(isCompleted || doc.final_pdf_path) && (
              <DownloadSignedPdf slug={slug} documentId={doc.id} title={doc.title} />
            )}
            {((canSend && canSendLink && !isDraft) || (canManage && doc.status !== "voided") || (canVoid && doc.status !== "voided")) && (
              <Menu
                label={t.docs.more}
                buttonClassName={buttonClass({ variant: "outline" })}
                trigger={() => (
                  <>
                    <MoreHorizontal className="h-4 w-4" />
                    {t.docs.more}
                  </>
                )}
              >
                {(close) => (
                  <>
                    {canSend && canSendLink && !isDraft && (
                      <MenuItem
                        icon={<Send />}
                        onClick={() => {
                          close();
                          send(true);
                        }}
                      >
                        {t.docs.sendAgainAll}
                      </MenuItem>
                    )}
                    {canManage && doc.status !== "voided" && (
                      <MenuItem
                        icon={<FileUp />}
                        onClick={() => {
                          close();
                          setUploadOpen(true);
                        }}
                      >
                        {t.docs.uploadSigned}
                      </MenuItem>
                    )}
                    {canVoid && doc.status !== "voided" && (
                      <MenuItem
                        icon={<Ban />}
                        danger
                        onClick={() => {
                          close();
                          setVoidOpen(true);
                        }}
                      >
                        {t.docs.voidDocument}
                      </MenuItem>
                    )}
                  </>
                )}
              </Menu>
            )}
          </>
        }
      />

      {/* ------------------------------------------------------ banner strip */}
      {/*
        Said plainly and near the top, because everything else on this screen —
        the completed badge, the signed timestamps, the download button — looks
        identical whether the signature was captured here or scanned in. Only
        one of those carries an IP, a one-time code and a content hash.
      */}
      {doc.final_pdf_source === "uploaded" && (
        <Banner
          tone="brand"
          icon={<FileUp className="h-4 w-4" />}
          title={t.docs.uploadedCopyTitle}
          body={t.docs.uploadedCopyBody}
        />
      )}
      {!doc.hash_ok && (
        <Banner tone="danger" icon={<ShieldAlert className="h-4 w-4" />} title={t.docs.hashBad} />
      )}
      {doc.locked_by && !isTerminal && (
        <Banner
          tone="warning"
          icon={<Tablet className="h-4 w-4" />}
          title={t.docs.lockedTitle}
          body={t.docs.lockedBody.replace("{name}", doc.locked_by_name ?? "")}
        />
      )}
      {/*
        Only on a draft: once sent, the text is frozen and nothing here can
        change it. Patient details the file lacks are not a block any more —
        the patient fills them when signing — so they get their own, calm line.
      */}
      {isDraft && patientFills.length > 0 && (
        <Banner
          tone="brand"
          icon={<UserPen className="h-4 w-4" />}
          title={t.docs.patientFillsTitle}
          body={`${patientFills.map((m) => m.label).join(locale === "ar" ? "، " : ", ")} — ${t.docs.patientFillsBody}`}
        />
      )}
      {isDraft && blockingMissing.length > 0 && (
        <Banner
          tone="warning"
          icon={<FileWarning className="h-4 w-4" />}
          title={t.docs.missingTitle.replace("{n}", String(blockingMissing.length))}
          body={t.docs.missingBody}
          action={
            <div className="mt-2 flex flex-wrap gap-1.5">
              {blockingMissing.map((m) => (
                <button
                  key={m.key}
                  onClick={() => {
                    setTab("values");
                    setOverrideKey(m.key);
                    setOverrideValue("");
                  }}
                  className="rounded-full border border-st-pending/40 bg-surface px-2.5 py-1 text-[0.75rem] font-medium text-st-pending hover:bg-st-pending-soft"
                >
                  {m.label}
                </button>
              ))}
              {doc.patient_id && blockingMissing.some((m) => m.fixHint === "patient") && (
                <Link
                  href={`/c/${slug}/patients/${doc.patient_id}`}
                  className="rounded-full bg-st-pending px-2.5 py-1 text-[0.75rem] font-semibold text-surface"
                >
                  {t.docs.fixInPatient}
                </Link>
              )}
            </div>
          }
        />
      )}
      {hasNoPhonePatient && !isTerminal && (
        <Banner
          tone="warning"
          icon={<Tablet className="h-4 w-4" />}
          title={t.docs.noPhoneTitle}
          body={t.docs.noPhoneBody.replace("{name}", patientSigner?.display_name ?? "")}
        />
      )}
      {sendResult?.waOffline && (
        <Banner
          tone="warning"
          icon={<Link2 className="h-4 w-4" />}
          title={t.docs.waOfflineTitle}
          body={t.docs.waOfflineBody}
        />
      )}
      {doc.status === "voided" && (
        <Banner
          tone="danger"
          icon={<Ban className="h-4 w-4" />}
          title={(t.docs.statuses as Record<string, string>).voided}
          body={doc.void_reason ?? ""}
          action={
            canManage ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await supersedeDocumentAction(slug, doc.id);
                    if (r.id) router.push(`/c/${slug}/documents/${r.id}`);
                  })
                }
              >
                {t.docs.replaceTitle}
              </Button>
            ) : undefined
          }
        />
      )}

      <SignersPanel
        slug={slug}
        documentId={doc.id}
        documentTitle={doc.title}
        status={doc.status}
        signers={detail.signers}
        staff={staff}
        userId={userId}
        canManage={canManage}
        canSendLink={canSendLink}
        roleName={roleName}
        onSignMine={() => setSignOpen(true)}
        onEditSigners={isDraft && canManage ? () => setEditSigners(detail.signers) : undefined}
        tz={tz}
      />

      <Tabs
        tabs={[
          { key: "document", label: t.docs.preview },
          { key: "values", label: t.docs.mergedValues },
          { key: "audit", label: t.docs.history, count: detail.events.length },
        ]}
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
      />

      {tab === "document" && (
        <Card className="p-6">
          {doc.source === "upload" ? (
            <div className="grid gap-3">
              <p className="text-[0.8125rem] text-ink-500">{t.docTemplates.uploadSub}</p>
              <a
                href={`/api/c/${slug}/documents/template-pdf?path=${encodeURIComponent(
                  doc.final_pdf_path ?? ""
                )}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-brand-700 hover:underline"
              >
                {t.docs.downloadPdf}
              </a>
            </div>
          ) : (
            <div dir={doc.language === "ar" ? "rtl" : "ltr"}>
              <DocumentBody html={detail.previewHtml} className="text-sm leading-relaxed" />
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4 text-[0.75rem] text-ink-400">
            {doc.content_hash ? (
              <>
                <span className="flex items-center gap-1.5">
                  {doc.hash_ok ? (
                    <ShieldCheck className="h-3.5 w-3.5 text-ok" />
                  ) : (
                    <ShieldAlert className="h-3.5 w-3.5 text-danger" />
                  )}
                  {doc.hash_ok ? t.docs.hashOk : t.docs.hashBad}
                </span>
                <code className="mono break-all" dir="ltr">
                  {doc.content_hash}
                </code>
              </>
            ) : (
              <span>{t.docs.notFrozen}</span>
            )}
          </div>
        </Card>
      )}

      {tab === "values" && (
        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-[0.9375rem] font-semibold">{t.docs.mergedValues}</h2>
            <p className="mt-0.5 text-[0.8125rem] text-ink-500">{t.docs.mergedValuesSub}</p>
          </div>
          <ul className="divide-y divide-line">
            {detail.fields.map((f) => {
              const label = locale === "ar" ? f.labelAr : f.label;
              const editing = overrideKey === f.key;
              return (
                <li key={f.key} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-32 text-[0.8125rem] font-medium">{label}</span>
                    {editing ? (
                      <span className="flex flex-1 flex-wrap items-center gap-2">
                        <Input
                          autoFocus
                          className="!w-auto min-w-48 flex-1"
                          value={overrideValue}
                          onChange={(e) => setOverrideValue(e.target.value)}
                        />
                        <Button
                          size="sm"
                          loading={pending}
                          onClick={() => saveOverride(f.key, f.label, f.labelAr, overrideValue)}
                        >
                          {t.common.save}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setOverrideKey(null)}>
                          {t.common.cancel}
                        </Button>
                      </span>
                    ) : (
                      <>
                        <span
                          className={`flex-1 text-sm ${
                            f.value ? "" : "text-danger"
                          } ${f.isOverride ? "doc-override px-1" : ""}`}
                        >
                          {f.value || "—"}
                        </span>
                        {f.used && <Badge status="neutral">{t.docs.preview}</Badge>}
                        {f.isOverride && <Badge status="pending">{t.docs.overridden}</Badge>}
                        {f.isOneOff && <Badge status="brand">{t.docs.oneOff}</Badge>}
                        {isDraft && canManage && (
                          <span className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t.docs.override}
                              onClick={() => {
                                setOverrideKey(f.key);
                                setOverrideValue(f.value);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {f.isOverride && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={t.docs.resetOverride}
                                loading={pending}
                                onClick={() =>
                                  start(async () => {
                                    await clearFieldValueAction(slug, doc.id, f.key);
                                  })
                                }
                              >
                                <RotateCcw className="h-4 w-4" />
                              </Button>
                            )}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {!f.value && f.fixHint && (
                    <p className="mt-1 text-[0.75rem] text-ink-500">
                      {f.fixHint === "patient" && doc.patient_id ? (
                        <Link
                          href={`/c/${slug}/patients/${doc.patient_id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {t.docs.fixInPatient}
                        </Link>
                      ) : f.fixHint === "clinic" ? (
                        <Link
                          href={`/c/${slug}/settings/profile`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {t.docs.fixInClinic}
                        </Link>
                      ) : f.fixHint === "service" ? (
                        <Link
                          href={`/c/${slug}/settings/services`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {t.docs.fixInService}
                        </Link>
                      ) : (
                        t.docs.fixHere
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {isDraft && canManage && (
            <div className="border-t border-line px-5 py-3">
              <Button variant="outline" size="sm" onClick={() => setOneOff({ label: "", value: "" })}>
                <Plus className="h-4 w-4" />
                {t.docs.addOneOff}
              </Button>
            </div>
          )}
        </Card>
      )}

      {tab === "audit" && (
        <Card>
          <div className="border-b border-line px-5 py-4">
            <h2 className="text-[0.9375rem] font-semibold">{t.docs.auditTrail}</h2>
            <p className="mt-0.5 text-[0.8125rem] text-ink-500">{t.docs.auditSub}</p>
          </div>
          <ol className="divide-y divide-line">
            {detail.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5 text-[0.8125rem]">
                <span className="min-w-44 font-medium">
                  {(t.docs.events as Record<string, string>)[e.event_type] ?? e.event_type}
                </span>
                <span className="flex-1 text-ink-500">
                  {e.actor_name ?? ""}
                  {e.ip_address ? (
                    <span dir="ltr" className="ms-2 text-ink-400">
                      {e.ip_address}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-ink-400 tnum">
                  {fmtDateTime(e.created_at, tz, locale)}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* ----------------------------------------------------------- modals */}

      <Modal open={signOpen} onClose={() => setSignOpen(false)} title={t.docs.countersign} wide>
        <div className="grid gap-4">
          <p className="text-[0.8125rem] text-ink-500">{t.docs.countersignHint}</p>
          <div
            dir={doc.language === "ar" ? "rtl" : "ltr"}
            className="max-h-64 overflow-y-auto rounded-card border border-line bg-subtle p-4"
          >
            <DocumentBody html={detail.previewHtml} className="text-[0.8125rem] leading-relaxed" />
          </div>

          {detail.extraQuestions
            .filter((q) => !q.roles?.length || (mySigner && q.roles.includes(mySigner.role_key)))
            .map((q) => (
              <Field key={q.key} label={locale === "ar" ? q.label_ar || q.label : q.label || q.label_ar} required={q.required}>
                <QuestionInput qkey={q.key} type={q.type} options={q.options} answers={answers} onChange={setAnswers} words={t.sign} />
              </Field>
            ))}

          {drawing ? (
            <div>
              <span className="mb-1.5 block text-[0.8125rem] font-semibold">{t.mySignature.draw}</span>
              <p className="mb-2 text-[0.75rem] text-ink-500">{t.mySignature.firstTime}</p>
              <SignaturePad ref={padRef} allowTyped />
              {hasSavedSignature && (
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => setDrawing(false)}>
                  {t.docs.signWithSaved}
                </Button>
              )}
            </div>
          ) : (
            <div className="rounded-card border border-line bg-subtle p-4">
              <p className="text-[0.8125rem]">{t.docs.signWithSaved}</p>
              <Button variant="ghost" size="sm" className="mt-1" onClick={() => setDrawing(true)}>
                {t.mySignature.replace}
              </Button>
            </div>
          )}

          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              className="!text-danger"
              onClick={() => {
                setSignOpen(false);
                setDeclineOpen(true);
              }}
            >
              {t.sign.decline}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setSignOpen(false)}>
                {t.common.cancel}
              </Button>
              <Button onClick={signNow} loading={pending}>
                <Check className="h-4 w-4" />
                {drawing ? t.sign.finish : t.docs.signWithSaved}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={declineOpen} onClose={() => setDeclineOpen(false)} title={t.sign.declineTitle}>
        <p className="mb-3 text-[0.8125rem] text-ink-500">{t.sign.declineBody}</p>
        <Field label={t.sign.declineReason}>
          <Textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDeclineOpen(false)}>
            {t.common.cancel}
          </Button>
          <Button
            variant="danger"
            loading={pending}
            onClick={() =>
              start(async () => {
                if (!mySigner) return;
                const r = await declineAsStaffAction(slug, doc.id, mySigner.id, declineReason);
                if (r.error) {
                  toast(t.common.genericError, "error");
                  return;
                }
                setDeclineOpen(false);
              })
            }
          >
            {t.sign.declineConfirm}
          </Button>
        </div>
      </Modal>

      <Modal open={!!oneOff} onClose={() => setOneOff(null)} title={t.docs.addOneOff}>
        {oneOff && (
          <div className="grid gap-4">
            <Field label={t.docs.oneOffLabel} required>
              <Input
                value={oneOff.label}
                onChange={(e) => setOneOff({ ...oneOff, label: e.target.value })}
              />
            </Field>
            <Field label={t.docs.oneOffValue} required>
              <Input
                value={oneOff.value}
                onChange={(e) => setOneOff({ ...oneOff, value: e.target.value })}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOneOff(null)}>
                {t.common.cancel}
              </Button>
              <Button
                loading={pending}
                disabled={!oneOff.label.trim() || !oneOff.value.trim()}
                onClick={() =>
                  start(async () => {
                    const key = `oneoff.${oneOff.label
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "_")
                      .replace(/^_|_$/g, "")
                      .slice(0, 40)}`;
                    await setFieldValueAction(slug, {
                      documentId: doc.id,
                      fieldKey: key,
                      label: oneOff.label,
                      labelAr: oneOff.label,
                      value: oneOff.value,
                      isOneOff: true,
                    });
                    setOneOff(null);
                  })
                }
              >
                {t.common.add}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <UploadSignedCopy
        slug={slug}
        documentId={doc.id}
        open={uploadOpen}
        signers={detail.signers.map((s) => ({
          id: s.id,
          name: s.display_name || roleName(s),
          role: roleName(s),
          alreadySigned: s.status === "signed",
          declined: s.status === "declined",
        }))}
        onClose={() => setUploadOpen(false)}
      />

      <SignerEditor
        slug={slug}
        documentId={doc.id}
        staff={staff}
        roles={detail.roles}
        signers={editSigners}
        tz={tz}
        onClose={() => setEditSigners(null)}
      />

      <Modal open={voidOpen} onClose={() => setVoidOpen(false)} title={t.docs.voidTitle}>
        <p className="mb-3 text-[0.8125rem] text-ink-500">{t.docs.voidBody}</p>
        <Field label={t.docs.voidReason} hint={t.common.optional}>
          <Textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setVoidOpen(false)}>
            {t.common.cancel}
          </Button>
          <Button
            variant="danger"
            loading={pending}
            onClick={() =>
              start(async () => {
                const r = await voidDocumentAction(slug, doc.id, voidReason);
                if (r.error) {
                  toast(
                    (t.docs.errors as Record<string, string>)[r.error] ?? t.common.genericError,
                    "error"
                  );
                  return;
                }
                toast(t.docs.voided);
                setVoidOpen(false);
              })
            }
          >
            {t.docs.voidDocument}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Banner({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: "danger" | "warning" | "brand";
  icon: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  const tones = {
    danger: "border-danger/30 bg-danger-soft text-danger",
    warning: "border-st-pending/30 bg-st-pending-soft text-st-pending",
    brand: "border-brand-200 bg-brand-50 text-brand-800",
  };
  return (
    <div className={`flex items-start gap-2.5 rounded-card border px-4 py-3 ${tones[tone]}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[0.8125rem] font-semibold">{title}</div>
        {body && <p className="mt-0.5 text-[0.75rem] leading-relaxed opacity-90">{body}</p>}
        {action}
      </div>
    </div>
  );
}

/**
 * Attaches a copy that was signed on paper.
 *
 * The signer list is a checklist rather than an assumption, because a scan of
 * page three proves nothing about who is on it — only the person holding the
 * paper knows. Anyone who declined here is shown but cannot be ticked: a refusal
 * recorded in the system is not something a later upload gets to overwrite.
 */
function UploadSignedCopy({
  slug,
  documentId,
  open,
  signers,
  onClose,
}: {
  slug: string;
  documentId: string;
  open: boolean;
  signers: { id: string; name: string; role: string; alreadySigned: boolean; declined: boolean }[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setNote("");
    // Everyone the upload can actually settle is ticked to start with; the
    // common case is a form that came back fully signed.
    setPicked(signers.filter((s) => !s.declined && !s.alreadySigned).map((s) => s.id));
  }, [open, signers]);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("signerIds", picked.join(","));
      if (note.trim()) fd.append("note", note.trim());
      const res = await fetch(`/api/c/${slug}/documents/${documentId}/final-pdf`, {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) {
        toast(
          (t.docs.errors as Record<string, string>)[json.error] ?? t.common.genericError,
          "error"
        );
        return;
      }
      toast(t.docs.uploadedOk);
      onClose();
      router.refresh();
    } catch {
      toast(t.common.genericError, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t.docs.uploadSigned}>
      <div className="grid gap-4">
        <p className="text-[0.8125rem] text-ink-500">{t.docs.uploadSignedBody}</p>

        <Field label={t.docs.uploadSignedFile} required>
          <FileField accept=".pdf,application/pdf" onFile={setFile} />
        </Field>

        <div>
          <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink-700">
            {t.docs.uploadSignedWho}
          </span>
          <ul className="grid gap-1 rounded-lg border border-line p-2">
            {signers.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-1.5 py-1">
                <span className="min-w-0 flex-1 text-[0.8125rem]">
                  {s.name}
                  <span className="ms-2 text-[0.75rem] text-ink-400">{s.role}</span>
                  {s.declined && (
                    <span className="ms-2 text-[0.75rem] text-danger">
                      {t.docs.signerStatuses.declined}
                    </span>
                  )}
                </span>
                <Toggle
                  checked={picked.includes(s.id) || s.alreadySigned}
                  disabled={s.declined || s.alreadySigned}
                  label={s.name}
                  onChange={(v) =>
                    setPicked((xs) => (v ? [...xs, s.id] : xs.filter((x) => x !== s.id)))
                  }
                />
              </li>
            ))}
          </ul>
        </div>

        <Field label={t.docs.uploadSignedNote}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button loading={busy} disabled={!file} onClick={submit}>
            <FileUp className="h-4 w-4" />
            {t.docs.uploadSigned}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Per-document signer set. Only reachable while the document is a draft. */
function SignerEditor({
  slug,
  documentId,
  staff,
  roles,
  signers,
  tz,
  onClose,
}: {
  slug: string;
  documentId: string;
  /** The clinic's timezone — and so its country, for a signer's number typed without a code. */
  tz: string;
  /** Who a staff line can name. It used to take a typed name, which nobody could ever sign as. */
  staff: StaffOption[];
  roles: { key: string; label: string; label_ar: string | null; is_staff: boolean }[];
  signers: Signer[] | null;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<Signer[]>(signers ?? []);

  useEffect(() => {
    if (signers) setRows(signers);
  }, [signers]);

  const label = (key: string) => {
    const r = roles.find((x) => x.key === key);
    const fallback = (t.docs.roles as Record<string, string>)[key];
    if (!r) return fallback ?? key;
    return locale === "ar" ? r.label_ar || fallback || r.label : r.label;
  };

  return (
    <Modal open={!!signers} onClose={onClose} title={t.docs.signers} wide>
      <div className="grid gap-4">
        <p className="text-[0.8125rem] text-ink-500">{t.docs.allAtOnce}</p>

        {rows.map((s, i) => {
          const isStaffRole = roles.find((r) => r.key === s.role_key)?.is_staff;
          return (
            <div key={i} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
              <Field label={t.docs.signerRole}>
                <Select
                  value={s.role_key}
                  onChange={(e) => {
                    const toStaff = !!roles.find((r) => r.key === e.target.value)?.is_staff;
                    setRows(
                      rows.map((x, idx) =>
                        idx === i
                          ? toStaff
                            ? { ...x, role_key: e.target.value, phone_e164: null, ...(isStaffRole ? {} : { display_name: "", user_id: null }) }
                            : { ...x, role_key: e.target.value, ...(isStaffRole ? { user_id: null, display_name: "" } : {}) }
                          : x
                      )
                    );
                  }}
                >
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {label(r.key)}
                    </option>
                  ))}
                </Select>
              </Field>
              {isStaffRole ? (
                <Field label={t.docs.signerName}>
                  <Select
                    value={s.user_id ?? ""}
                    onChange={(e) => {
                      const m = staff.find((x) => x.user_id === e.target.value);
                      setRows(
                        rows.map((x, idx) =>
                          idx === i ? { ...x, user_id: m?.user_id ?? null, display_name: m?.full_name ?? "", phone_e164: null } : x
                        )
                      );
                    }}
                  >
                    <option value="">{t.docs.chooseSigner}</option>
                    {staff.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.full_name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Field label={t.docs.signerName}>
                  <Input
                    value={s.display_name}
                    onChange={(e) =>
                      setRows(rows.map((x, idx) => (idx === i ? { ...x, display_name: e.target.value } : x)))
                    }
                  />
                </Field>
              )}
              {!isStaffRole && (
                <Field label={t.docs.signerPhone}>
                  <PhoneInput
                    value={s.phone_e164 ?? ""}
                    defaultCountry={countryFromClinic({ timezone: tz })}
                    placeholder="xxxxxxxxxx"
                    onChange={(v) => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, phone_e164: v } : x)))}
                  />
                </Field>
              )}
              {s.role_key === "guardian" && (
                <Field label={t.docs.relationship}>
                  <Input
                    value={s.relationship ?? ""}
                    placeholder={t.docs.relationshipPlaceholder}
                    onChange={(e) =>
                      setRows(rows.map((x, idx) => (idx === i ? { ...x, relationship: e.target.value } : x)))
                    }
                  />
                </Field>
              )}
              <div className="sm:col-span-2 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                  {t.docs.removeSigner}
                </Button>
              </div>
            </div>
          );
        })}

        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() =>
            setRows([
              ...rows,
              {
                id: `new-${rows.length}`,
                role_key: roles[0]?.key ?? "patient",
                role_label: null,
                role_label_ar: null,
                is_staff: false,
                signing_order: rows.length,
                is_required: true,
                display_name: "",
                phone_e164: null,
                user_id: null,
                relationship: null,
                status: "pending",
                link_opened_at: null,
                viewed_at: null,
                signed_at: null,
                decline_reason: null,
                signed_in_person: false,
              },
            ])
          }
        >
          <Plus className="h-4 w-4" />
          {t.docs.addSigner}
        </Button>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button
            loading={pending}
            disabled={rows.length === 0}
            onClick={() =>
              start(async () => {
                const r = await setSignersAction(slug, {
                  documentId,
                  signers: rows.map((s, i) => ({
                    roleKey: s.role_key,
                    order: i,
                    required: s.is_required,
                    displayName: s.display_name,
                    phone: s.phone_e164,
                    userId: s.user_id,
                    relationship: s.relationship,
                  })),
                });
                if (r.error) {
                  toast(t.common.genericError, "error");
                  return;
                }
                toast(t.common.saved);
                onClose();
              })
            }
          >
            {t.common.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
