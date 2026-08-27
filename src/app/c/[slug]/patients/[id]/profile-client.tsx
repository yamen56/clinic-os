"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { fmtDate, fmtDateTime, fmtMoney, fmtRelative } from "@/lib/dates";
import { formatPhone } from "@/lib/phone";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field, Select, Textarea } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import type { CountryCode } from "@/lib/phone";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Avatar, EmptyState, Spinner, Tabs } from "@/components/ui/misc";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { useToast } from "@/components/ui/toast";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import {
  addTagAction,
  removeTagAction,
  addNoteAction,
  noteHistoryAction,
  saveNoteCategoryAction,
  deletePatientFileAction,
  setPatientStatusAction,
  mergePatientsAction,
  openConversationAction,
} from "../actions";
import { sendAllPendingAction } from "../../documents/actions";
import { VoiceRecorder } from "@/components/voice-recorder";
import { VoiceNote } from "@/components/voice-note";
import { DOC_STATUS_BADGE } from "@/components/esign/status";
import { DownloadSignedPdf } from "@/components/esign/download-signed";
import { NewDocumentModal, type PickableTemplate } from "@/components/esign/new-document-modal";
import type { DocumentListRow } from "@/lib/esign/queries";
import {
  MessageCircle,
  Phone as PhoneIcon,
  CalendarPlus,
  ReceiptText,
  FileSignature,
  Send,
  X,
  Plus,
  Upload,
  FileText,
  Image as ImageIcon,
  Trash2,
  Merge,
  Archive,
  MoreVertical,
  StickyNote,
  History,
  Filter,
  Pencil,
} from "lucide-react";

export type NoteRow = {
  id: string;
  body: string;
  category_id: string | null;
  created_at: string;
  edited_at: string | null;
  author: string | null;
  edited_by_name: string | null;
  audio_path: string | null;
  audio_mime: string | null;
  audio_seconds: number | null;
  /** 1 means written once and never changed. */
  version_count: number;
};

export type NoteCategoryRow = {
  id: string;
  key: string | null;
  name: string;
  name_ar: string | null;
  color: string;
  is_system: boolean;
  active: boolean;
  sort: number;
};

type Patient = {
  id: string;
  full_name: string;
  phone_e164: string | null;
  secondary_phone_e164: string | null;
  extra_phones: string[];
  birth_date: string | null;
  gender: string | null;
  tags: string[];
  source: string;
  status: string;
  notes_summary: string;
  custom_fields: Record<string, unknown>;
  insurer_id: string | null;
  insurance_no: string;
  insurance_valid_until: string | null;
  created_at: string;
};

/**
 * One of the clinic's own field definitions. `source_column` names a real column
 * on `patients` — those already have their own input above, so this form only
 * renders the ones that live in `custom_fields`.
 */
type FieldDef = {
  id: string;
  key: string;
  label: string;
  label_ar: string | null;
  field_type: string;
  options: string[];
  is_required: boolean;
  storage_key: string | null;
  source_column: string | null;
};

const storageKeyOf = (d: FieldDef) => d.storage_key ?? d.key.replace(/^patient\./, "");

const apptStatus: Record<string, StatusKey> = {
  pending_approval: "pending",
  scheduled: "scheduled",
  confirmed: "confirmed",
  completed: "completed",
  no_show: "no_show",
  cancelled: "cancelled",
};

export function PatientProfile(props: {
  slug: string;
  tz: string;
  currency: string;
  balanceDue: number;
  patient: Patient;
  notes: NoteRow[];
  noteCategories: NoteCategoryRow[];
  files: { id: string; file_name: string; mime_type: string; size_bytes: number; kind: string; created_at: string }[];
  appointments: { id: string; starts_at: string; status: string; service_name: string | null; service_name_ar: string | null; doctor_name: string | null }[];
  invoices: { id: string; number: string; status: string; total: string; amount_paid: string; created_at: string }[];
  conversation: { id: string; msgs: { id: string; direction: string; sender_kind: string; body: string; msg_type: string; created_at: string }[] | null } | null;
  defs: FieldDef[];
  activity: { action: string; created_at: string; detail: Record<string, unknown>; actor: string | null }[];
  documents: DocumentListRow[];
  docTemplates: PickableTemplate[];
  canSendDocuments: boolean;
  /** The clinic's country, so a new number defaults to the right dialling code. */
  country: CountryCode;
  /** The clinic's tag vocabulary — suggestions, and the colour each tag wears. */
  clinicTags: { name: string; color: string }[];
  /** Active insurance companies. Empty for a clinic that only takes cash. */
  insurers: { id: string; name: string }[];
}) {
  const { slug, tz, currency } = props;
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [p, setP] = useState(props.patient);
  const [tab, setTab] = useState("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const { patch, state } = useAutosave({
    url: `/api/c/${slug}/patients/${p.id}`,
    entityKey: `patient:${p.id}`,
    onConflict: (data) => {
      const other = (data as { other?: { id: string; full_name: string } }).other;
      toast(`${t.patients.phoneTaken}${other ? ` — ${other.full_name}` : ""}`, "error");
    },
  });

  const set = (fields: Partial<Patient>) => {
    setP((prev) => ({ ...prev, ...fields }));
    patch(fields as Record<string, unknown>);
  };
  const setCustom = (key: string, value: unknown) => {
    setP((prev) => ({ ...prev, custom_fields: { ...prev.custom_fields, [key]: value } }));
    patch({ custom_fields: { [key]: value } });
  };

  /*
    The clinic can rename any field, including the built-in ones, so the labels
    on this form come from the definitions rather than from the dictionary. The
    dictionary is the fallback for a clinic that has not touched them.
  */
  const defLabel = (key: string, fallback: string) => {
    const d = props.defs.find((x) => x.key === key);
    if (!d) return fallback;
    return locale === "ar" ? d.label_ar || d.label : d.label;
  };
  // Fields backed by a real column already have their own input above.
  const extraDefs = props.defs.filter((d) => !d.source_column);

  const waLink = p.phone_e164 ? `https://wa.me/${p.phone_e164.replace("+", "")}` : null;

  /*
    Messaging from inside the platform, as opposed to the wa.me link beside it.
    The difference is not cosmetic: a message sent here is queued through the
    sending rails — the daily cap, the quiet-hours window, the delivery receipt —
    and every colleague can see it on the thread afterwards. One sent from the
    phone is invisible to all of that.

    The thread need not exist yet; the action creates it. That is the whole point
    of the button.
  */
  const [opening, startOpening] = useTransition();
  const openThread = () => {
    if (!p.phone_e164) return toast(t.patients.messageNoPhone, "error");
    startOpening(async () => {
      const r = await openConversationAction(slug, p.id);
      if (r.id) router.push(`/c/${slug}/conversations?open=${r.id}`);
      else toast(r.error === "no_phone" ? t.patients.messageNoPhone : t.patients.messageFailed, "error");
    });
  };
  const upcoming = props.appointments.find(
    (a) => new Date(a.starts_at) > new Date() && !["cancelled", "no_show"].includes(a.status)
  );

  const tabs = [
    { key: "overview", label: t.patients.tabs.overview },
    { key: "notes", label: t.patients.tabs.notes, count: props.notes.length },
    { key: "appointments", label: t.patients.tabs.appointments, count: props.appointments.length },
    { key: "files", label: t.patients.tabs.files, count: props.files.length },
    // Between Files and Invoices, as specified: a signed form belongs with the
    // patient's other paperwork, not filed away under billing.
    { key: "documents", label: t.patients.tabs.documents, count: props.documents.length },
    { key: "invoices", label: t.patients.tabs.invoices, count: props.invoices.length },
    { key: "conversation", label: t.patients.tabs.conversation },
  ];

  return (
    <>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start gap-4">
        <Avatar name={p.full_name} size={52} color={p.status === "lead" ? "var(--color-st-pending)" : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              className="min-w-40 max-w-full rounded-md border border-transparent bg-transparent text-xl font-semibold tracking-tight outline-none transition-colors hover:border-line focus:border-brand-500 focus:bg-surface"
              value={p.full_name}
              onChange={(e) => set({ full_name: e.target.value })}
              aria-label={t.patients.fullName}
            />
            {p.status === "lead" && <Badge status="pending">{t.patients.statusLead}</Badge>}
            {p.status === "archived" && <Badge status="cancelled">{t.patients.statusArchived}</Badge>}
            <SaveIndicator state={state} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-500">
            {p.phone_e164 && <span className="num tnum">{formatPhone(p.phone_e164)}</span>}
            {p.secondary_phone_e164 && (
              <span className="num tnum text-ink-400">{formatPhone(p.secondary_phone_e164)}</span>
            )}
            {p.extra_phones?.map((ph) => (
              <span key={ph} className="num tnum text-ink-400">{formatPhone(ph)}</span>
            ))}
            <span>
              {(t.patients.sources as Record<string, string>)[p.source] ?? p.source} ·{" "}
              {fmtDate(p.created_at, tz, locale)}
            </span>
          </div>
          <TagsRow
            slug={slug}
            patientId={p.id}
            tags={p.tags}
            known={props.clinicTags}
            onChange={(tags) => setP((prev) => ({ ...prev, tags }))}
          />
        </div>
        {/*
          Five actions in a row that would not wrap: on a phone they ran to 722
          pixels and took the whole page sideways with them. The header above
          already wraps; this did not, and adding the Message button made a
          long-standing overflow impossible to miss.
        */}
        <div className="flex flex-wrap items-center gap-2">
          {p.phone_e164 && (
            <Button variant="soft" size="sm" onClick={openThread} disabled={opening}>
              <MessageCircle className="h-4 w-4" />
              {t.patients.message}
            </Button>
          )}
          {/* The patient's own WhatsApp, for a call or a look — not the way to
              send, which is the button beside it. */}
          {waLink && (
            <a href={waLink} target="_blank" rel="noreferrer">
              <Button variant="outline" size="sm">
                {t.patients.whatsappOpen}
              </Button>
            </a>
          )}
          {p.phone_e164 && (
            <a href={`tel:${p.phone_e164}`}>
              <Button variant="outline" size="sm">
                <PhoneIcon className="h-4 w-4" />
                {t.patients.call}
              </Button>
            </a>
          )}
          <Link href={`/c/${slug}/calendar?patient=${p.id}`}>
            <Button variant="outline" size="sm">
              <CalendarPlus className="h-4 w-4" />
              {t.patients.bookAppointment}
            </Button>
          </Link>
          <Link href={`/c/${slug}/invoices/new?patient=${p.id}`}>
            <Button variant="outline" size="sm">
              <ReceiptText className="h-4 w-4" />
              {t.patients.createInvoice}
            </Button>
          </Link>
          <div className="relative">
            <Button variant="ghost" size="icon" onClick={() => setMenuOpen((v) => !v)} aria-label={t.common.actions}>
              <MoreVertical className="h-4.5 w-4.5" />
            </Button>
            {menuOpen && (
              <div className="absolute end-0 top-10 z-30 w-52 rounded-card border border-line bg-surface p-1.5 shadow-pop animate-fade-up">
                <button
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-ink-900/4"
                  onClick={() => {
                    setMenuOpen(false);
                    setMergeOpen(true);
                  }}
                >
                  <Merge className="h-4 w-4 text-ink-400" />
                  {t.patients.merge.button}
                </button>
                <button
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger-soft"
                  onClick={() => {
                    setMenuOpen(false);
                    setArchiveOpen(true);
                  }}
                >
                  <Archive className="h-4 w-4" />
                  {p.status === "archived" ? t.patients.restore : t.patients.archive}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="mt-5">
        {tab === "overview" && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="grid gap-4 lg:col-span-2">
              <Card className="p-5">
                <h3 className="mb-4 text-[15px] font-semibold">{t.patients.overview.details}</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={defLabel("patient.phone", t.patients.phone)}>
                    <PhoneInput
                      value={p.phone_e164}
                      defaultCountry={props.country}
                      onChange={(v) => patch({ phone_e164: v })}
                    />
                  </Field>
                  <Field label={t.patients.secondaryPhone}>
                    <PhoneInput
                      value={p.secondary_phone_e164}
                      defaultCountry={props.country}
                      onChange={(v) => patch({ secondary_phone_e164: v })}
                    />
                  </Field>
                  <Field label={defLabel("patient.birth_date", t.patients.birthDate)}>
                    <Input
                      type="date"
                      defaultValue={p.birth_date?.slice(0, 10) ?? ""}
                      onChange={(e) => patch({ birth_date: e.target.value })}
                    />
                  </Field>
                  <Field label={defLabel("patient.gender", t.patients.gender)}>
                    <Select
                      value={p.gender ?? ""}
                      onChange={(e) => set({ gender: e.target.value || null })}
                    >
                      <option value="">—</option>
                      <option value="male">{t.patients.male}</option>
                      <option value="female">{t.patients.female}</option>
                    </Select>
                  </Field>
                  {/*
                    Who covers this person, so an invoice can split itself and
                    reception can answer "how much do I pay today" without
                    looking it up somewhere else. Hidden entirely until the
                    clinic has added a company — a self-paying practice should
                    not be asked about insurance on every file.
                  */}
                  {props.insurers.length > 0 && (
                    <>
                      <Field label={t.insurers.insurer}>
                        <Select
                          value={p.insurer_id ?? ""}
                          onChange={(e) => set({ insurer_id: e.target.value || null })}
                        >
                          <option value="">{t.insurers.none}</option>
                          {props.insurers.map((i) => (
                            <option key={i.id} value={i.id}>{i.name}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t.insurers.policyNo}>
                        <Input
                          dir="ltr"
                          defaultValue={p.insurance_no ?? ""}
                          onChange={(e) => patch({ insurance_no: e.target.value })}
                        />
                      </Field>
                      <Field label={t.insurers.validUntil}>
                        <Input
                          type="date"
                          defaultValue={p.insurance_valid_until?.slice(0, 10) ?? ""}
                          onChange={(e) => patch({ insurance_valid_until: e.target.value })}
                        />
                      </Field>
                    </>
                  )}
                </div>
                {extraDefs.length > 0 && (
                  <>
                    <h4 className="mb-3 mt-6 text-[13px] font-semibold text-ink-500">
                      {t.patients.overview.customFields}
                    </h4>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {extraDefs.map((d) => {
                        const label = locale === "ar" ? d.label_ar || d.label : d.label;
                        const sk = storageKeyOf(d);
                        const val = p.custom_fields?.[sk];
                        if (d.field_type === "select") {
                          return (
                            <Field key={d.id} label={label} required={d.is_required}>
                              <Select
                                value={String(val ?? "")}
                                onChange={(e) => setCustom(sk, e.target.value)}
                              >
                                <option value="">—</option>
                                {(d.options ?? []).map((o) => (
                                  <option key={o} value={o}>
                                    {o}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                          );
                        }
                        if (d.field_type === "checkbox") {
                          return (
                            <Field key={d.id} label={label} required={d.is_required}>
                              <Select
                                value={val === true ? "yes" : val === false ? "no" : ""}
                                onChange={(e) =>
                                  setCustom(sk, e.target.value === "" ? null : e.target.value === "yes")
                                }
                              >
                                <option value="">—</option>
                                <option value="yes">{t.common.yes}</option>
                                <option value="no">{t.common.no}</option>
                              </Select>
                            </Field>
                          );
                        }
                        if (d.field_type === "longtext") {
                          return (
                            <Field key={d.id} label={label} required={d.is_required}>
                              <Textarea
                                defaultValue={String(val ?? "")}
                                className="min-h-20"
                                onChange={(e) => setCustom(sk, e.target.value)}
                              />
                            </Field>
                          );
                        }
                        return (
                          <Field key={d.id} label={label} required={d.is_required}>
                            <Input
                              type={
                                d.field_type === "number"
                                  ? "number"
                                  : d.field_type === "date"
                                    ? "date"
                                    : d.field_type === "email"
                                      ? "email"
                                      : "text"
                              }
                              dir={d.field_type === "phone" || d.field_type === "email" ? "ltr" : undefined}
                              defaultValue={String(val ?? "")}
                              onChange={(e) => setCustom(sk, e.target.value)}
                            />
                          </Field>
                        );
                      })}
                    </div>
                  </>
                )}
              </Card>
              <Card className="p-5">
                <h3 className="mb-3 text-[15px] font-semibold">{t.patients.overview.summary}</h3>
                <Textarea
                  defaultValue={p.notes_summary}
                  placeholder={t.patients.overview.summaryPlaceholder}
                  className="min-h-28"
                  onChange={(e) => patch({ notes_summary: e.target.value })}
                />
              </Card>
            </div>
            <div className="grid content-start gap-4">
              <Card className="p-5">
                <h3 className="text-[13px] font-semibold text-ink-500">{t.patients.overview.balanceDue}</h3>
                <div className={`mt-1 text-2xl font-semibold tnum ${props.balanceDue > 0 ? "text-st-pending" : ""}`}>
                  {fmtMoney(props.balanceDue, currency, locale)}
                </div>
              </Card>
              <Card className="p-5">
                <h3 className="text-[13px] font-semibold text-ink-500">{t.patients.overview.upcoming}</h3>
                {upcoming ? (
                  <div className="spine mt-2 ps-3" style={{ "--spine-color": "var(--color-st-confirmed)" } as React.CSSProperties}>
                    <div className="text-sm font-medium">
                      {(locale === "ar" ? upcoming.service_name_ar : null) || upcoming.service_name || "—"}
                    </div>
                    <div className="text-[13px] text-ink-500">
                      {fmtDateTime(upcoming.starts_at, tz, locale)}
                      {upcoming.doctor_name ? ` · ${upcoming.doctor_name}` : ""}
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-ink-400">{t.patients.overview.noUpcoming}</p>
                )}
              </Card>
              <Card className="p-5">
                <h3 className="mb-2 text-[13px] font-semibold text-ink-500">
                  {t.patients.overview.recentActivity}
                </h3>
                {props.activity.length === 0 ? (
                  <p className="text-sm text-ink-400">{t.patients.overview.noActivity}</p>
                ) : (
                  <ul className="grid gap-2 text-[13px]">
                    {props.activity.slice(0, 8).map((a, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span className="truncate text-ink-700">
                          {a.action.replace("patient.", "")} {a.actor ? `· ${a.actor}` : ""}
                        </span>
                        <span className="shrink-0 text-ink-400" suppressHydrationWarning>
                          {fmtRelative(a.created_at, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        )}

        {tab === "notes" && (
          <NotesTab
            slug={slug}
            patientId={p.id}
            notes={props.notes}
            categories={props.noteCategories}
            tz={tz}
          />
        )}
        {tab === "appointments" && (
          <Card>
            {props.appointments.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={<CalendarPlus />}
                  title={t.patients.overview.noUpcoming}
                  action={
                    <Link href={`/c/${slug}/calendar?patient=${p.id}`}>
                      <Button>{t.patients.bookAppointment}</Button>
                    </Link>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {props.appointments.map((a) => (
                  <li key={a.id} className="flex items-center gap-4 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {(locale === "ar" ? a.service_name_ar : null) || a.service_name || "—"}
                      </div>
                      <div className="text-[13px] text-ink-500">
                        {fmtDateTime(a.starts_at, tz, locale)}
                        {a.doctor_name ? ` · ${a.doctor_name}` : ""}
                      </div>
                    </div>
                    <Badge status={apptStatus[a.status] ?? "neutral"}>
                      {(t.calendar.statuses as Record<string, string>)[a.status] ?? a.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {tab === "files" && <FilesTab slug={slug} patientId={p.id} files={props.files} tz={tz} />}
        {tab === "documents" && (
          <DocumentsTab
            slug={slug}
            patientId={p.id}
            tz={tz}
            documents={props.documents}
            templates={props.docTemplates}
            canSend={props.canSendDocuments}
          />
        )}
        {tab === "invoices" && (
          <Card>
            {props.invoices.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  icon={<ReceiptText />}
                  title={t.common.none}
                  action={
                    <Link href={`/c/${slug}/invoices/new?patient=${p.id}`}>
                      <Button>{t.patients.createInvoice}</Button>
                    </Link>
                  }
                />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {props.invoices.map((inv) => {
                  const partial = inv.status === "partially_paid";
                  const left = Number(inv.total) - Number(inv.amount_paid);
                  return (
                    <li key={inv.id}>
                      <Link
                        href={`/c/${slug}/invoices/${inv.id}`}
                        className="flex items-center gap-4 px-5 py-3 hover:bg-sunken"
                      >
                        <span className="flex-1 text-sm font-medium" dir="ltr">
                          {inv.number}
                        </span>
                        {/* On a partly paid invoice the total alone is the least
                            useful number — what was paid and what is left are
                            what anyone opening this file wants. */}
                        <span className="text-end">
                          <span className="block text-sm tnum">
                            {fmtMoney(
                              partial ? Number(inv.amount_paid) : Number(inv.total),
                              currency,
                              locale
                            )}
                          </span>
                          {partial && (
                            <span className="block text-[12px] text-ink-400 tnum">
                              {t.invoices.ofTotal.replace(
                                "{total}",
                                fmtMoney(Number(inv.total), currency, locale)
                              )}
                            </span>
                          )}
                        </span>
                        <span className="text-end">
                          <Badge
                            status={
                              inv.status === "paid"
                                ? "confirmed"
                                : inv.status === "void"
                                  ? "cancelled"
                                  : inv.status === "draft"
                                    ? "neutral"
                                    : "pending"
                            }
                          >
                            {(t.invoices.statuses as Record<string, string>)[inv.status] ?? inv.status}
                          </Badge>
                          {partial && (
                            <span className="mt-0.5 block text-[12px] font-medium text-st-pending tnum">
                              {t.invoices.leftToPay.replace(
                                "{amount}",
                                fmtMoney(left, currency, locale)
                              )}
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
        {tab === "conversation" && (
          <Card className="p-5">
            {!props.conversation?.msgs?.length ? (
              /* The empty state is exactly where someone wants to start a
                 conversation, so it offers to rather than just reporting none. */
              <EmptyState
                icon={<MessageCircle />}
                title={t.common.none}
                action={
                  p.phone_e164 ? (
                    <Button variant="soft" size="sm" onClick={openThread} disabled={opening}>
                      <MessageCircle className="h-4 w-4" />
                      {t.patients.message}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="grid gap-2">
                  {[...props.conversation.msgs].reverse().map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${
                        m.direction === "out"
                          ? "self-end bg-brand-50 text-brand-900"
                          : "self-start border border-line bg-sunken"
                      }`}
                    >
                      {m.body || `[${m.msg_type}]`}
                      <div className="mt-0.5 text-[11px] text-ink-400">
                        {m.sender_kind} · {fmtDateTime(m.created_at, tz, locale)}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4">
                  <Link href={`/c/${slug}/conversations?open=${props.conversation.id}`}>
                    <Button variant="soft" size="sm">
                      <MessageCircle className="h-4 w-4" />
                      {t.nav.conversations}
                    </Button>
                  </Link>
                </div>
              </>
            )}
          </Card>
        )}
      </div>

      <MergeModal
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        slug={slug}
        keepId={p.id}
        keepName={p.full_name}
      />
      <ConfirmDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title={p.status === "archived" ? t.patients.restore : t.patients.archive}
        body={p.status === "archived" ? undefined : t.common.confirmDeleteBody}
        confirmLabel={p.status === "archived" ? t.patients.restore : t.patients.archive}
        cancelLabel={t.common.cancel}
        danger={p.status !== "archived"}
        onConfirm={async () => {
          const next = p.status === "archived" ? "active" : "archived";
          await setPatientStatusAction(slug, p.id, next);
          setP((prev) => ({ ...prev, status: next }));
          setArchiveOpen(false);
          toast(next === "archived" ? t.patients.archived : t.common.saved);
        }}
      />
    </>
  );
}

function TagsRow({
  slug,
  patientId,
  tags,
  known,
  onChange,
}: {
  slug: string;
  patientId: string;
  tags: string[];
  /** The clinic's catalogue: what to suggest, and what colour each tag wears. */
  known: { name: string; color: string }[];
  onChange: (tags: string[]) => void;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [val, setVal] = useState("");
  const colorOf = (tag: string) => known.find((k) => k.name === tag)?.color;

  const commit = async () => {
    const tag = val.trim().replace(/\s+/g, " ");
    setAdding(false);
    setVal("");
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag]);
    await addTagAction(slug, patientId, tag);
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => {
        const color = colorOf(tag);
        return (
          <span
            key={tag}
            /*
              A tag from the catalogue wears its own colour; one typed here a
              moment ago has not been read back yet, so it keeps the brand pill
              until the next load rather than flashing an arbitrary colour.
            */
            className={`group inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              color ? "text-white" : "bg-brand-50 text-brand-700"
            }`}
            style={color ? { background: color } : undefined}
          >
            {tag}
            <button
              aria-label={`${t.common.delete} ${tag}`}
              onClick={async () => {
                onChange(tags.filter((x) => x !== tag));
                await removeTagAction(slug, patientId, tag);
              }}
              className="opacity-40 transition-opacity hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
      {adding ? (
        <>
          <input
            autoFocus
            list={`tags-${patientId}`}
            className="h-6 w-28 rounded-full border border-brand-300 px-2.5 text-xs outline-none"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setAdding(false);
                setVal("");
              }
            }}
          />
          {/* Suggest what the clinic already uses — the cheapest way to stop a
              third spelling of the same label entering the vocabulary. */}
          <datalist id={`tags-${patientId}`}>
            {known
              .filter((k) => !tags.includes(k.name))
              .map((k) => (
                <option key={k.name} value={k.name} />
              ))}
          </datalist>
        </>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 py-0.5 text-xs text-ink-400 transition-colors hover:border-brand-400 hover:text-brand-600"
        >
          <Plus className="h-3 w-3" />
          {t.patients.addTag}
        </button>
      )}
    </div>
  );
}

/**
 * The notes tab.
 *
 * Three rules the UI has to carry, all of them about a note being a clinical
 * record rather than a scratchpad:
 *
 *  - **There is no delete.** A note is corrected, never removed. The edit is
 *    autosaved as before, but every version is kept and the original stays one
 *    tap away, so correcting a note is safe and losing one is not possible.
 *  - **Categories are the clinic's**, not two names we picked. They filter the
 *    list, and a new one can be made from here — the moment you need a category
 *    is the moment you are writing a note that does not fit the ones you have.
 *  - **A note can be spoken.** Fifteen seconds of dictation between patients
 *    beats two minutes of typing that never happens.
 */
function NotesTab({
  slug,
  patientId,
  notes,
  categories,
  tz,
}: {
  slug: string;
  patientId: string;
  notes: NoteRow[];
  categories: NoteCategoryRow[];
  tz: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [newCat, setNewCat] = useState(false);
  const [catName, setCatName] = useState("");

  const active = categories.filter((c) => c.active);
  const [categoryId, setCategoryId] = useState<string | null>(
    active.find((c) => c.key === "clinical")?.id ?? active[0]?.id ?? null
  );
  const catName_ = (c: NoteCategoryRow) => (locale === "ar" ? c.name_ar || c.name : c.name);
  const byId = new Map(categories.map((c) => [c.id, c]));

  const shown = filter ? notes.filter((n) => n.category_id === filter) : notes;
  const countFor = (id: string) => notes.filter((n) => n.category_id === id).length;

  /** A typed note. Server action, so it rides a transition like everything else. */
  const submit = () =>
    start(async () => {
      if (!draft.trim()) return;
      await addNoteAction(slug, patientId, draft.trim(), categoryId);
      setDraft("");
      router.refresh();
    });

  /**
   * A recording, filed the moment the recorder stops.
   *
   * Deliberately outside `startTransition`. Voice goes over multipart, so it is
   * a plain fetch rather than a server action, and running a second-long upload
   * inside a transition had the `router.refresh()` at the end of it aborted —
   * the note was created (the POST returned 200 with its id) and the list never
   * repainted, which reads as a recording that vanished. `busy` drives the
   * pending state instead, which is what it was already there for.
   *
   * The clip is an argument rather than state: the setState from the stop event
   * has not landed by the time this runs, so reading it back would file a note
   * with no audio on it.
   *
   * A note cannot be deleted, only corrected, so a clip that was never meant to
   * exist would sit in the patient's record forever. Under a second is a mis-tap
   * rather than a note, and is thrown away.
   */
  const onRecorded = async (rec: { blob: Blob; seconds: number } | null) => {
    if (!rec) return;
    if (rec.seconds < 1) return toast(t.patients.notes.voiceTooShort, "error");

    setBusy(true);
    try {
      const fd = new FormData();
      const ext = (rec.blob.type.split("/")[1] ?? "webm").split(";")[0];
      fd.append("audio", rec.blob, `voice.${ext}`);
      fd.append("patientId", patientId);
      fd.append("seconds", String(rec.seconds));
      fd.append("body", draft.trim());
      if (categoryId) fd.append("categoryId", categoryId);
      const res = await fetch(`/api/c/${slug}/notes/voice`, { method: "POST", body: fd });
      if (!res.ok) return toast(t.common.genericError, "error");
      // The preview is gone, so this toast is the only confirmation that the
      // recording became a note.
      toast(t.patients.notes.voiceSaved);
      setDraft("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const addCategory = () =>
    start(async () => {
      const name = catName.trim();
      if (!name) return;
      const r = await saveNoteCategoryAction(slug, { name });
      if (r.error || !r.id) {
        toast(t.common.genericError, "error");
        return;
      }
      setCategoryId(r.id);
      setCatName("");
      setNewCat(false);
      router.refresh();
    });

  return (
    <div className="grid gap-4">
      {/* ------------------------------------------------------- composer */}
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <StickyNote className="h-4 w-4 shrink-0 text-ink-400" />
          <div className="flex flex-wrap gap-1 rounded-full bg-sunken p-0.5">
            {active.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategoryId(c.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  categoryId === c.id ? "bg-surface shadow-card" : "text-ink-500"
                }`}
                style={categoryId === c.id ? { color: c.color } : undefined}
              >
                {catName_(c)}
              </button>
            ))}
            <button
              onClick={() => setNewCat(true)}
              aria-label={t.patients.notes.newCategory}
              className="rounded-full px-2 py-1 text-xs text-ink-400 transition-colors hover:text-ink-700"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {newCat && (
          <div className="mb-2 flex items-center gap-2">
            <Input
              autoFocus
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCategory()}
              placeholder={t.patients.notes.newCategory}
              className="!h-8 max-w-56"
            />
            <Button size="sm" onClick={addCategory} loading={pending} disabled={!catName.trim()}>
              {t.common.save}
            </Button>
            <button
              onClick={() => {
                setNewCat(false);
                setCatName("");
              }}
              className="text-[13px] text-ink-500"
            >
              {t.common.cancel}
            </button>
          </div>
        )}

        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t.patients.notes.placeholder}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <VoiceRecorder
            immediate
            onReady={onRecorded}
            disabled={pending || busy}
            labels={{
              record: t.patients.notes.record,
              stop: t.patients.notes.stopRecording,
              discard: t.common.delete,
              denied: t.patients.notes.micDenied,
              unsupported: t.patients.notes.micUnsupported,
              noMic: t.patients.notes.micNone,
              insecure: t.patients.notes.micInsecure,
              retry: t.patients.notes.micRetry,
            }}
          />
          <Button
            size="sm"
            disabled={!draft.trim() || pending || busy}
            loading={pending || busy}
            onClick={submit}
          >
            {t.patients.notes.add}
          </Button>
        </div>
      </Card>

      {/* --------------------------------------------------------- filter */}
      {notes.length > 0 && categories.length > 1 && (
        <div className="-mt-1 flex flex-wrap items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 shrink-0 text-ink-400" />
          <button
            onClick={() => setFilter(null)}
            className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
              filter === null ? "border-ink-900 bg-ink-900 text-white" : "border-line-strong text-ink-500"
            }`}
          >
            {t.common.all} <span className="tnum opacity-70">{notes.length}</span>
          </button>
          {categories
            // A retired category still gets a chip while notes sit under it —
            // otherwise those notes are unreachable from the filter bar.
            .filter((c) => c.active || countFor(c.id) > 0)
            .map((c) => {
              const n = countFor(c.id);
              if (!n) return null;
              const on = filter === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setFilter(on ? null : c.id)}
                  className="rounded-full border px-3 py-1 text-[12px] font-medium transition-colors"
                  style={
                    on
                      ? { background: c.color, borderColor: c.color, color: "#fff" }
                      : { borderColor: "var(--color-line-strong)", color: c.color }
                  }
                >
                  {catName_(c)} <span className="tnum opacity-70">{n}</span>
                </button>
              );
            })}
        </div>
      )}

      {/* ---------------------------------------------------------- list */}
      {shown.length === 0 ? (
        <EmptyState
          icon={<StickyNote />}
          title={notes.length ? t.patients.notes.noneInFilter : t.patients.notes.empty}
          body={notes.length ? undefined : t.patients.notes.emptyBody}
        />
      ) : (
        shown.map((n) => (
          <NoteItem
            key={n.id}
            slug={slug}
            note={n}
            category={n.category_id ? byId.get(n.category_id) ?? null : null}
            categories={active}
            tz={tz}
            locale={locale}
          />
        ))
      )}
    </div>
  );
}

function NoteItem({
  slug,
  note,
  category,
  categories,
  tz,
  locale,
}: {
  slug: string;
  note: NoteRow;
  category: NoteCategoryRow | null;
  categories: NoteCategoryRow[];
  tz: string;
  locale: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [history, setHistory] = useState<
    { id: string; body: string; author: string | null; created_at: string }[] | null
  >(null);
  const [showHistory, setShowHistory] = useState(false);
  const [pending, start] = useTransition();

  /*
    An explicit edit, rather than a textarea that is always live.

    A note is a clinical record. Leaving it as an open box invited a stray
    keystroke into somebody's history, and it forced the category switcher to
    live permanently under every note — a row of chips repeated down the whole
    page for something that is changed once, if ever. Both now sit behind one
    button, and the text underneath is just text.
  */
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(note.body);
  const [draftCat, setDraftCat] = useState<string>(note.category_id ?? "");

  const catName = (c: NoteCategoryRow | null) =>
    c ? (locale === "ar" ? c.name_ar || c.name : c.name) : t.patients.notes.uncategorised;

  const openEdit = () => {
    // Reopening after a cancel must show what is saved, not the abandoned edit.
    setDraftBody(note.body);
    setDraftCat(note.category_id ?? "");
    setEditing(true);
  };

  const save = () =>
    start(async () => {
      const res = await fetch(`/api/c/${slug}/notes/${note.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The same endpoint the autosave used, so the edit still lands through
        // saveNoteVersion and the previous text is kept in the history.
        body: JSON.stringify({
          patch: { body: draftBody, categoryId: draftCat || null },
        }),
      });
      if (!res.ok) return toast(t.common.genericError, "error");
      setEditing(false);
      toast(t.patients.notes.noteSaved);
      router.refresh();
    });

  const openHistory = () => {
    setShowHistory(true);
    if (history) return;
    start(async () => setHistory(await noteHistoryAction(slug, note.id)));
  };

  return (
    <Card className="p-4">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-400">
        <span className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold"
            style={{ color: category?.color ?? "var(--color-ink-500)", background: "var(--color-sunken)" }}
          >
            {catName(category)}
          </span>
          {note.author ? `${note.author} · ` : ""}
          {fmtDateTime(note.created_at, tz, locale)}
          {/*
            "Edited" is stated rather than implied. A record that changed and
            does not say so is the thing the version history exists to prevent.
          */}
          {note.edited_at && (
            <button
              onClick={openHistory}
              className="font-medium text-ink-500 underline underline-offset-2 transition-colors hover:text-brand-700"
            >
              {t.patients.notes.edited}
            </button>
          )}
        </span>
        <span className="flex items-center gap-2">
          {/* No delete. See lib/notes.ts. */}
          {note.version_count > 1 && !note.edited_at && (
            <button onClick={openHistory} className="text-ink-400 hover:text-ink-700" aria-label={t.patients.notes.history}>
              <History className="h-4 w-4" />
            </button>
          )}
          {/* No aria-label: it would override the visible word with a different
              one, and then somebody driving by voice says "Edit" and nothing
              happens. Label and accessible name should be the same string. */}
          <button
            onClick={openEdit}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t.common.edit}
          </button>
        </span>
      </div>

      {note.audio_path && (
        <VoiceNote
          src={`/api/c/${slug}/notes/${note.id}/audio`}
          seconds={note.audio_seconds}
          label={t.patients.notes.playVoice}
        />
      )}

      {/*
        Read-only. `whitespace-pre-wrap` because a doctor's note is written in
        lines — a list of findings collapses into a paragraph without it.
      */}
      {note.body ? (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-900">{note.body}</p>
      ) : (
        note.audio_path && (
          <p className="text-[13px] italic text-ink-400">{t.patients.notes.voicePlaceholder}</p>
        )
      )}

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title={t.patients.notes.editNote}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(false)}>
              {t.common.cancel}
            </Button>
            <Button onClick={save} loading={pending}>
              {t.patients.notes.saveNote}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {categories.length > 0 && (
            <Field label={t.patients.notes.noteCategory}>
              <Select value={draftCat} onChange={(e) => setDraftCat(e.target.value)}>
                <option value="">{t.patients.notes.uncategorised}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {locale === "ar" ? c.name_ar || c.name : c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t.patients.notes.noteText}>
            <Textarea
              autoFocus
              rows={6}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder={note.audio_path ? t.patients.notes.voicePlaceholder : undefined}
            />
          </Field>
          {/* Says what this dialog does not touch, because a recording is the
              one part of a note nobody can retype. */}
          {note.audio_path && (
            <p className="text-[12px] text-ink-500">{t.patients.notes.voiceKept}</p>
          )}
        </div>
      </Modal>

      <Modal
        open={showHistory}
        onClose={() => setShowHistory(false)}
        title={t.patients.notes.history}
      >
        {!history ? (
          <Spinner />
        ) : (
          <ol className="grid gap-3">
            {history.map((v, i) => (
              <li key={v.id} className="rounded-lg border border-line p-3">
                <div className="mb-1 flex items-center gap-2 text-[12px] text-ink-400">
                  <Badge status={i === 0 ? "brand" : "neutral"}>
                    {i === 0 ? t.patients.notes.original : `${t.patients.notes.version} ${i + 1}`}
                  </Badge>
                  {v.author ? `${v.author} · ` : ""}
                  {fmtDateTime(v.created_at, tz, locale)}
                </div>
                <p className="whitespace-pre-wrap text-[13px] text-ink-900">
                  {v.body || <span className="text-ink-400">{t.patients.notes.emptyVersion}</span>}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </Card>
  );
}


function FilesTab({
  slug,
  patientId,
  files,
  tz,
}: {
  slug: string;
  patientId: string;
  files: { id: string; file_name: string; mime_type: string; size_bytes: number; kind: string; created_at: string }[];
  tz: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [kind, setKind] = useState("other");
  const [uploading, setUploading] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("kind", kind);
        const res = await fetch(`/api/c/${slug}/patients/${patientId}/files`, {
          method: "POST",
          body: fd,
        });
        if (res.status === 413) {
          toast(t.patients.files.tooLarge, "error");
        } else if (!res.ok) {
          toast(t.common.genericError, "error");
        }
      }
      router.refresh();
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="!w-auto">
          {Object.entries(t.patients.files.kinds).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = "";
          }}
        />
        <Button loading={uploading} onClick={() => fileInput.current?.click()}>
          <Upload className="h-4 w-4" />
          {t.patients.files.upload}
        </Button>
        <span className="text-[13px] text-ink-400">{t.patients.files.dropHint}</span>
      </Card>

      {files.length === 0 ? (
        <EmptyState icon={<FileText />} title={t.patients.files.empty} body={t.patients.files.emptyBody} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {files.map((f) => (
            <Card key={f.id} className="flex items-center gap-3 p-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                {f.mime_type.startsWith("image/") ? <ImageIcon className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={`/api/c/${slug}/files/${f.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-sm font-medium hover:text-brand-700"
                >
                  {f.file_name}
                </a>
                <div className="text-[12px] text-ink-400">
                  {(t.patients.files.kinds as Record<string, string>)[f.kind]} ·{" "}
                  {(f.size_bytes / 1024).toFixed(0)} KB · {fmtDate(f.created_at, tz, locale)}
                </div>
              </div>
              <button
                onClick={() => setDeleteId(f.id)}
                className="text-ink-300 transition-colors hover:text-danger"
                aria-label={t.common.delete}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t.common.confirmDeleteTitle}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteId) {
            await deletePatientFileAction(slug, deleteId);
            toast(t.patients.files.deleted);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/**
 * Every document on this patient's file, with what it is still waiting for.
 *
 * "New" is one tap to a template picker and one tap to a merged, signable
 * document — the four-tap budget in the brief is measured from here.
 */
function DocumentsTab({
  slug,
  patientId,
  tz,
  documents,
  templates,
  canSend,
}: {
  slug: string;
  patientId: string;
  tz: string;
  documents: DocumentListRow[];
  templates: PickableTemplate[];
  canSend: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [pending, start] = useTransition();

  const pendingCount = documents.filter((d) =>
    ["draft", "sent", "partially_signed"].includes(d.status)
  ).length;

  return (
    <div className="grid gap-4">
      {canSend && (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <Button onClick={() => setNewOpen(true)}>
            <FileSignature className="h-4 w-4" />
            {t.docs.newDocument}
          </Button>
          {pendingCount > 1 && (
            <Button
              variant="outline"
              loading={pending}
              onClick={() =>
                start(async () => {
                  const r = await sendAllPendingAction(slug, patientId);
                  if (r.error) {
                    toast(
                      (t.docs.errors as Record<string, string>)[r.error] ?? t.common.genericError,
                      "error"
                    );
                    return;
                  }
                  toast(t.docs.sendAllDone.replace("{n}", String(r.sent ?? 0)));
                  router.refresh();
                })
              }
            >
              <Send className="h-4 w-4" />
              {t.docs.sendAllPending.replace("{n}", String(pendingCount))}
            </Button>
          )}
        </Card>
      )}

      {documents.length === 0 ? (
        <EmptyState
          icon={<FileSignature />}
          title={t.docs.empty}
          body={t.docs.emptyBody}
          action={canSend ? <Button onClick={() => setNewOpen(true)}>{t.docs.newDocument}</Button> : undefined}
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                <Link href={`/c/${slug}/documents/${d.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium hover:text-brand-700">{d.title}</span>
                    <Badge status={(DOC_STATUS_BADGE[d.status] ?? "neutral") as StatusKey}>
                      {(t.docs.statuses as Record<string, string>)[d.status] ?? d.status}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-ink-500">
                    {d.waiting_on && !["completed", "voided"].includes(d.status) && (
                      <span className="text-st-pending">
                        {t.docs.waitingOnN.replace("{name}", d.waiting_on)}
                      </span>
                    )}
                    {d.signer_count > 1 && (
                      <span className="tnum">
                        {d.signed_count}/{d.signer_count}
                      </span>
                    )}
                    <span>{fmtDate(d.created_at, tz, locale)}</span>
                  </div>
                </Link>
                {(d.status === "completed" || d.final_pdf_path) && (
                  <DownloadSignedPdf
                    slug={slug}
                    documentId={d.id}
                    title={d.title}
                    variant="ghost"
                    size="icon"
                    iconOnly
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <NewDocumentModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        slug={slug}
        templates={templates}
        patientId={patientId}
      />
    </div>
  );
}

function MergeModal({
  open,
  onClose,
  slug,
  keepId,
  keepName,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  keepId: string;
  keepName: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string; phone_e164: string | null }[]>([]);
  const [selected, setSelected] = useState<{ id: string; full_name: string } | null>(null);
  const [pending, start] = useTransition();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (val: string) => {
    setQ(val);
    setSelected(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      if (val.trim().length < 2) {
        setResults([]);
        return;
      }
      const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(val)}`);
      const data = await res.json();
      setResults(
        (data.results ?? []).filter((r: { id: string }) => r.id !== keepId)
      );
    }, 250);
  };

  return (
    <Modal open={open} onClose={onClose} title={t.patients.merge.title}>
      <p className="mb-4 text-[13px] text-ink-500">{t.patients.merge.hint}</p>
      <Field label={t.patients.merge.searchOther}>
        <Input value={q} onChange={(e) => search(e.target.value)} placeholder={t.patients.searchPlaceholder} />
      </Field>
      <div className="mt-2 grid gap-1">
        {results.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r)}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-start text-sm transition-colors ${
              selected?.id === r.id ? "border-brand-500 bg-brand-50" : "border-line hover:bg-sunken"
            }`}
          >
            <Avatar name={r.full_name} size={28} />
            <span className="flex-1">{r.full_name}</span>
            {r.phone_e164 && (
              <span dir="ltr" className="text-[12px] text-ink-400 tnum">
                {formatPhone(r.phone_e164)}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button
          disabled={!selected}
          loading={pending}
          onClick={() =>
            start(async () => {
              if (!selected) return;
              const r = await mergePatientsAction(slug, keepId, selected.id);
              if (r.error) {
                toast(t.common.genericError, "error");
                return;
              }
              toast(t.patients.merge.done);
              onClose();
              router.refresh();
            })
          }
        >
          {t.patients.merge.confirm} · {keepName}
        </Button>
      </div>
    </Modal>
  );
}
