"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { DateTime } from "luxon";
import { fmtDate, fmtMoney } from "@/lib/dates";
import { countryFromClinic, formatPhone } from "@/lib/phone";
import { PhoneInput } from "@/components/ui/phone-input";
import { addedByLabel, type AddedBy } from "@/lib/added-by";
import { PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { SearchInput, Select, Field, Input, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Avatar } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { ExportMenu } from "@/components/export-menu";
import { useToast } from "@/components/ui/toast";
import { createPatientAction } from "./actions";
import { splitTyped } from "@/components/appointments/patient-picker";
import { Users, Plus, Upload, BellOff, SlidersHorizontal, X } from "lucide-react";

type Row = {
  id: string;
  fullName: string;
  phone: string | null;
  tags: string[];
  source: string;
  status: string;
  lastVisitAt: string | null;
  /* Half the keyset cursor; the id is the other half. See the load-more route. */
  createdAt: string;
  nextAppointment: string | null;
  mutedFromAutomations: boolean;
  addedBy: AddedBy | null;
  fileNo: number | null;
  /** Null when this reader may not see it. */
  owed: number | null;
};

/** One of the clinic's patient fields (Settings → Fields), as the new-patient form needs it. */
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
const blankNew = { name: "", phone: "", gender: "" as "" | "male" | "female", birthDate: "", nationalId: "" };

export function PatientsList({
  slug,
  patients,
  total,
  pageSize,
  allTags,
  fields = [],
  tz,
  initialFilters,
  openNew,
  canExportAll,
  canImport,
  canSeeOwes = false,
  currency,
}: {
  slug: string;
  /** The first page, rendered on the server and arriving with the document. */
  patients: Row[];
  total: number;
  pageSize: number;
  allTags: string[];
  /** The clinic's patient fields: labels for the ones asked on adding, and which are required. */
  fields?: FieldDef[];
  tz: string;
  initialFilters: { q: string; tag: string; source: string; visit: string; optedOut: string; owes: string };
  /** Open the new-patient dialog on arrival — the dashboard shortcut. */
  openNew?: boolean;
  /*
    Opening one file is the job; taking every file is a separate decision, and so
    is bringing a list in. Both are capabilities an owner grants — see
    CAPABILITY_GROUPS — and both are enforced again at the door they open.
  */
  canExportAll: boolean;
  canImport: boolean;
  /** Invoices, not filtered to their own work: the Owes column and the "Owe money" preset. */
  canSeeOwes?: boolean;
  currency: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  /** The clinic's own country: where a number typed without a code is from. */
  const country = countryFromClinic({ timezone: tz });
  const [f, setF] = useState(initialFilters);
  const [newOpen, setNewOpen] = useState(Boolean(openNew));
  /*
    The new patient: who they are — name, phone, gender, date of birth, the
    national number — and every field the clinic itself made required, so the
    file opens complete rather than with half of it left for somebody to
    remember (2026-10-28).
  */
  const [nw, setNw] = useState(blankNew);
  const [custom, setCustom] = useState<Record<string, string | boolean | null>>({});
  const name = nw.name;
  const [err, setErr] = useState<{ field: string; text: string } | null>(null);
  const def = (key: string) => fields.find((d) => d.key === key) ?? null;
  const labelOf = (key: string, fallback: string) => {
    const d = def(key);
    return d ? (locale === "ar" ? d.label_ar || d.label : d.label) : fallback;
  };
  /*
    Not the phone: every clinic was seeded with it marked required, for its
    documents, and a patient with no phone — a child, a walk-in — has always
    been addable here (createPatientAction).
  */
  const requiredKey = (key: string) => key !== "patient.phone" && Boolean(def(key)?.is_required);
  const nationalIdDef = def("patient.national_id");
  const extraRequired = fields.filter((d) => d.is_required && !d.source_column && d !== nationalIdDef);
  const missing =
    !name.trim() ||
    (requiredKey("patient.gender") && !nw.gender) ||
    (requiredKey("patient.birth_date") && !nw.birthDate) ||
    (Boolean(nationalIdDef?.is_required) && !nw.nationalId.trim()) ||
    extraRequired.some((d) => {
      const v = custom[storageKeyOf(d)];
      return v === undefined || v === null || (typeof v === "string" && !v.trim());
    });
  const [pending, start] = useTransition();
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
    Pages after the first, held here rather than pushed back through the URL.

    Re-rendering the whole route to append a hundred rows would refetch the
    count, the tag list and every row already on screen, and would lose the
    reader's scroll position — for a button whose entire promise is "more of
    what you are already looking at".
  */
  const [extra, setExtra] = useState<Row[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  /*
    Whether the server said there is another page. Seeded from the count so the
    button appears on first render without an extra request, then replaced by
    what the route actually reports.
  */
  const [hasMore, setHasMore] = useState(total > patients.length);

  const shown = patients.concat(extra);

  // A new filter is a different list; anything paged in under the old one is not
  // part of it. Keyed on the server-rendered page, which is what changes when a
  // filter lands.
  useEffect(() => {
    setExtra([]);
    setMoreError(false);
    setHasMore(total > patients.length);
  }, [patients, total]);

  const loadMore = async () => {
    const last = shown[shown.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const p = new URLSearchParams();
      if (f.q) p.set("q", f.q);
      if (f.tag) p.set("tag", f.tag);
      if (f.source) p.set("source", f.source);
      if (f.visit) p.set("visit", f.visit);
      if (f.optedOut) p.set("optedOut", f.optedOut);
      if (f.owes) p.set("owes", f.owes);
      p.set("cursorTs", last.createdAt);
      p.set("cursorId", last.id);
      const res = await fetch(`/api/c/${slug}/patients/list?${p}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { patients: Row[]; hasMore: boolean };
      /*
        Filtered against what is already on screen. The cursor makes a duplicate
        impossible on the server side, but a double-tap can put two identical
        requests in flight, and React would then warn about repeated keys rather
        than anything visible going wrong.
      */
      setExtra((prev) => {
        const seen = new Set(patients.concat(prev).map((r) => r.id));
        return prev.concat(body.patients.filter((r) => !seen.has(r.id)));
      });
      setHasMore(body.hasMore);
    } catch {
      // Left on screen with the button still there: the rows already loaded are
      // still good, and the fix for a blip is to press it again.
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = (next: typeof f) => {
    setF(next);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      const p = new URLSearchParams();
      if (next.q) p.set("q", next.q);
      if (next.tag) p.set("tag", next.tag);
      if (next.source) p.set("source", next.source);
      if (next.visit) p.set("visit", next.visit);
      if (next.optedOut) p.set("optedOut", next.optedOut);
      if (next.owes) p.set("owes", next.owes);
      router.replace(`/c/${slug}/patients${p.size ? `?${p}` : ""}`);
    }, 300);
  };

  useEffect(() => () => debounce.current ? clearTimeout(debounce.current) : undefined, []);

  const submitNew = () =>
    start(async () => {
      setErr(null);
      const r = await createPatientAction(slug, {
        fullName: name,
        phone: nw.phone,
        gender: nw.gender,
        birthDate: nw.birthDate,
        nationalId: nationalIdDef ? nw.nationalId : "",
        custom,
      });
      if (r.error) {
        setErr(
          r.error === "invalid_phone"
            ? { field: "phone", text: t.common.invalidPhone }
            : r.error === "invalid_national_id"
              ? { field: "nid", text: t.patients.nationalIdTenDigits }
              : r.error === "national_id_taken"
                ? { field: "nid", text: `${t.patients.nationalIdTaken}${r.other ? ` — ${r.other}` : ""}` }
                : r.error === "invalid_birth_date"
                  ? { field: "birth", text: t.patients.birthDateFuture }
                  : { field: "form", text: t.common.required }
        );
        return;
      }
      if (r.existing) toast(t.patients.existingPatient, "info");
      setNewOpen(false);
      setNw(blankNew);
      setCustom({});
      router.push(`/c/${slug}/patients/${r.id}`);
    });

  const sourceLabel = (s: string) =>
    (t.patients.sources as Record<string, string>)[s] ?? s;
  // The person who typed the patient in, when one did; the source otherwise.
  const originLabel = (p: { source: string; addedBy: AddedBy | null }) =>
    p.addedBy ? addedByLabel(p.addedBy, t) : sourceLabel(p.source);

  const F = t.patients.filters;
  const intl = locale === "ar" ? "ar-JO-u-nu-latn" : "en-GB";
  const money = (n: number) => fmtMoney(n, currency, locale);
  /*
    Three presets and one menu (Yamen, 2026-11-16: few options). The presets are
    the questions the list is opened for — everyone, who owes us, who has not
    been back — and they replace one another; the menu holds the rest.
  */
  const preset = f.owes === "1" ? "owes" : f.visit === "90" ? "notSeen" : f.tag || f.source || f.visit || f.optedOut ? null : "all";
  const presets: { key: "all" | "owes" | "notSeen"; label: string; next: typeof f }[] = [
    { key: "all", label: F.all, next: { ...f, owes: "", visit: "", tag: "", source: "", optedOut: "" } },
    ...(canSeeOwes ? [{ key: "owes" as const, label: F.owes, next: { ...f, owes: "1", visit: "" } }] : []),
    { key: "notSeen", label: F.notSeen, next: { ...f, visit: "90", owes: "" } },
  ];
  /* What the Filters menu has set, as chips that each take one filter off. */
  const chips: { key: string; label: string; clear: typeof f }[] = [
    ...(f.tag ? [{ key: "tag", label: f.tag, clear: { ...f, tag: "" } }] : []),
    ...(f.source ? [{ key: "source", label: sourceLabel(f.source), clear: { ...f, source: "" } }] : []),
    ...(f.visit && f.visit !== "90"
      ? [{ key: "visit", label: f.visit === "30" ? F.noVisit30 : F.noVisit180, clear: { ...f, visit: "" } }]
      : []),
    ...(f.optedOut ? [{ key: "muted", label: F.mutedOnly, clear: { ...f, optedOut: "" } }] : []),
  ];
  const menuCount = [f.tag, f.source, f.visit && f.visit !== "90" ? f.visit : "", f.optedOut].filter(Boolean).length;
  const filtered = Boolean(f.q || f.tag || f.source || f.visit || f.optedOut || f.owes);
  const exportHref = (() => {
    const p = new URLSearchParams();
    for (const k of ["q", "tag", "source", "visit", "optedOut", "owes"] as const) if (f[k]) p.set(k, f[k]);
    return `/api/c/${slug}/patients/export-all${p.size ? `?${p}` : ""}`;
  })();

  /*
    The table's columns, as one template for the header and every row. "Added
    by" joins on a wide screen only; the money column only for somebody who may
    see what patients owe (canSeeOwes) — the amount is not in the page at all
    otherwise.
  */
  const cols = ["minmax(0,2.4fr)", "minmax(0,1.2fr)", "minmax(0,1fr)", "minmax(0,1fr)", ...(canSeeOwes ? ["minmax(0,0.9fr)"] : [])];
  const gridVars = {
    "--cols": cols.join(" "),
    "--cols-xl": [...cols, "minmax(0,1.2fr)"].join(" "),
  } as React.CSSProperties;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-baseline gap-2">
            {t.patients.title}
            <span className="text-[1rem] font-semibold text-ink-400 tnum" data-patient-total>
              {total.toLocaleString(intl)}
            </span>
          </span>
        }
        action={
          <>
            {/*
              One button that asks which file (2026-11-21). It exports what is on
              screen — the search and filters the list is showing — and the PDF's
              cover sheet says which, so nobody mistakes a slice for the whole.
            */}
            {canExportAll && <ExportMenu href={exportHref} pdfHint={t.exports.patientsPdfHint} />}
            {canImport && (
              <Link href={`/c/${slug}/patients/import`} className={buttonClass({ variant: "outline" })}>
                <Upload className="h-4 w-4" />
                {t.import.title}
              </Link>
            )}
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" />
              {t.patients.newPatient}
            </Button>
          </>
        }
      />

      {/* Search, the presets, and one Filters menu for everything else. No bare `grid` here: qa-phase2 finds the new-patient name by `.grid input`. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput
          className="w-full sm:w-72"
          placeholder={t.patients.searchPlaceholder}
          value={f.q}
          onChange={(e) => apply({ ...f, q: e.target.value })}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {/* On a 320px phone the three names ran 17px past the screen: tighter there, and never wider than it. */}
          <div className="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-ink-900/5 p-1 [scrollbar-width:none]" role="group" data-patient-presets>
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => apply(p.next)}
                aria-pressed={preset === p.key}
                data-preset={p.key}
                className={`h-8 shrink-0 touch-manipulation whitespace-nowrap rounded-full px-3 text-[0.8125rem] font-medium transition-colors duration-140 ease-out max-md:h-10 max-[360px]:px-2 ${
                  preset === p.key ? "bg-segment text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-900"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <FilterMenu
            label={F.button}
            count={menuCount}
            f={f}
            onChange={apply}
            allTags={allTags}
            sources={t.patients.sources as Record<string, string>}
            words={F}
          />
        </div>
      </div>

      {chips.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5" data-filter-chips>
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => apply(c.clear)}
              className="inline-flex h-8 touch-manipulation items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[0.78125rem] text-ink-700 transition-colors hover:border-line-strong max-md:h-10"
            >
              {c.label}
              <X className="h-3.5 w-3.5 text-ink-400" aria-label={F.clear} />
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={filtered ? t.common.noResults : t.patients.noPatients}
          action={
            !filtered ? (
              <Button onClick={() => setNewOpen(true)}>{t.patients.newPatient}</Button>
            ) : f.q.trim().length >= 2 ? (
              /* Nobody by that name or number: they are new, and what was searched is how they start. */
              <Button
                onClick={() => {
                  const typed = splitTyped(f.q);
                  setNw({ ...blankNew, name: typed.fullName, phone: typed.phone });
                  setNewOpen(true);
                }}
                data-create-searched
              >
                {t.calendar.createNamed.replace("{q}", f.q.trim())}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card" style={gridVars} data-patient-table>
          {/* The column names, on a screen wide enough for columns. */}
          <div className="hidden gap-4 border-b border-line bg-sunken/60 px-5 py-2 text-[0.75rem] font-medium text-ink-500 lg:grid lg:[grid-template-columns:var(--cols)] xl:[grid-template-columns:var(--cols-xl)]" aria-hidden>
            <span>{F.colPatient}</span>
            <span>{t.patients.phone}</span>
            <span>{t.patients.lastVisit}</span>
            <span>{F.colNext}</span>
            {canSeeOwes && <span className="text-end">{F.colOwes}</span>}
            <span className="hidden xl:block">{F.colAddedBy}</span>
          </div>
          <ul className="divide-y divide-line">
            {shown.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/c/${slug}/patients/${p.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-140 ease-out hover:bg-sunken lg:grid lg:gap-4 lg:px-5 lg:py-2 lg:[grid-template-columns:var(--cols)] xl:[grid-template-columns:var(--cols-xl)]"
                >
                  {/* Who: the face of the row, and on a phone everything but one chip. */}
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={p.fullName} size={34} color={p.status === "lead" ? "var(--color-st-pending-soft)" : undefined} ink={p.status === "lead" ? "var(--color-st-pending)" : undefined} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink-900">{p.fullName}</span>
                        {p.status === "lead" && <Badge status="pending">{t.patients.statusLead}</Badge>}
                        {p.mutedFromAutomations && (
                          <BellOff className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-label={t.patients.automations.muted} />
                        )}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-x-2 text-[0.75rem] text-ink-500">
                        {p.phone && <span className="num tnum lg:hidden">{formatPhone(p.phone)}</span>}
                        {p.fileNo !== null && <span className="tnum text-ink-400">#{p.fileNo}</span>}
                        {p.tags.slice(0, 2).map((tag) => (
                          <span key={tag} className="hidden truncate rounded-full bg-brand-100 px-1.5 text-[length:max(11px,0.6875rem)] text-brand-700 sm:inline">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <span className="hidden text-[0.8125rem] text-ink-700 lg:block">
                    {p.phone ? <span className="num tnum">{formatPhone(p.phone)}</span> : <Dash />}
                  </span>
                  <span className="hidden text-[0.8125rem] text-ink-700 lg:block">
                    {p.lastVisitAt ? (
                      <span title={fmtDate(p.lastVisitAt, tz, locale)} suppressHydrationWarning>
                        {ago(p.lastVisitAt, intl)}
                      </span>
                    ) : (
                      <Dash />
                    )}
                  </span>
                  <span className="hidden lg:block">
                    {p.nextAppointment ? (
                      <span className="inline-flex rounded-full bg-st-confirmed-soft px-2 py-0.5 text-[0.75rem] font-medium text-st-confirmed tnum">
                        {shortDay(p.nextAppointment, tz, intl)}
                      </span>
                    ) : (
                      <Dash />
                    )}
                  </span>
                  {canSeeOwes && (
                    <span className="hidden text-end text-[0.8125rem] lg:block" data-owed={p.owed ?? 0}>
                      {p.owed && p.owed > 0 ? <span className="font-semibold text-danger tnum">{money(p.owed)}</span> : <Dash />}
                    </span>
                  )}
                  <span className="hidden truncate text-[0.8125rem] text-ink-500 xl:block" data-added-by={p.addedBy ? "person" : p.source}>
                    {originLabel(p)}
                  </span>

                  {/* On a phone: the one thing about them worth a glance — what they owe, else when they are next in. */}
                  <span className="shrink-0 lg:hidden">
                    {canSeeOwes && p.owed && p.owed > 0 ? (
                      <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[0.75rem] font-semibold text-danger tnum">{money(p.owed)}</span>
                    ) : p.nextAppointment ? (
                      <span className="rounded-full bg-st-confirmed-soft px-2 py-0.5 text-[0.75rem] font-medium text-st-confirmed tnum">
                        {shortDay(p.nextAppointment, tz, intl)}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The way out of the first hundred: a count of what is on screen, and the button for the rest. */}
      {shown.length > 0 && hasMore && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <p className="text-[0.75rem] text-ink-400 tnum">
            {t.patients.showingOf.replace("{shown}", String(shown.length)).replace("{total}", String(total))}
          </p>
          <Button variant="outline" onClick={loadMore} loading={loadingMore}>
            {t.patients.loadMore.replace("{n}", String(pageSize))}
          </Button>
          {moreError && (
            <p className="text-[0.8125rem] text-danger" role="alert">
              {t.patients.loadMoreFailed}
            </p>
          )}
        </div>
      )}

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title={t.patients.newPatient} wide>
        <div className="grid gap-4" data-new-patient>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.patients.fullName} required>
              <Input value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} autoFocus data-new-name />
            </Field>
            <Field
              label={labelOf("patient.phone", t.patients.phone)}
              required={requiredKey("patient.phone")}
              error={err?.field === "phone" ? err.text : undefined}
            >
              {/* The country first, the clinic's own by default — a Palestinian or Saudi number is one tap away. */}
              <PhoneInput
                value={nw.phone}
                defaultCountry={country}
                onChange={(v) => setNw({ ...nw, phone: v })}
                placeholder="xxxxxxxxxx"
                inputAttrs={{ "data-new-phone": "" }}
              />
            </Field>
            <Field label={labelOf("patient.gender", t.patients.gender)} required={requiredKey("patient.gender")}>
              <Select value={nw.gender} onChange={(e) => setNw({ ...nw, gender: e.target.value as typeof nw.gender })} data-new-gender>
                <option value="">—</option>
                <option value="male">{t.patients.male}</option>
                <option value="female">{t.patients.female}</option>
              </Select>
            </Field>
            <Field
              label={labelOf("patient.birth_date", t.patients.birthDate)}
              required={requiredKey("patient.birth_date")}
              error={err?.field === "birth" ? err.text : undefined}
            >
              <Input
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                value={nw.birthDate}
                onChange={(e) => setNw({ ...nw, birthDate: e.target.value })}
                data-new-birth
              />
            </Field>
            {/* The national number — what an insurer, and Hakeem, match the patient on. The clinic's own field: renamed or hidden in settings, it is here too. */}
            {nationalIdDef && (
              <Field
                label={labelOf("patient.national_id", "")}
                required={nationalIdDef.is_required}
                error={err?.field === "nid" ? err.text : undefined}
              >
                <Input dir="ltr" inputMode="numeric" value={nw.nationalId} onChange={(e) => setNw({ ...nw, nationalId: e.target.value })} data-new-nid />
              </Field>
            )}
            {/* Whatever else the clinic made required in Settings → Fields. */}
            {extraRequired.map((d) => {
              const label = locale === "ar" ? d.label_ar || d.label : d.label;
              const sk = storageKeyOf(d);
              const val = custom[sk];
              const setVal = (v: string | boolean | null) => setCustom((prev) => ({ ...prev, [sk]: v }));
              if (d.field_type === "select" || d.field_type === "checkbox") {
                const opts = d.field_type === "checkbox" ? null : d.options ?? [];
                return (
                  <Field key={d.id} label={label} required>
                    <Select
                      value={opts ? String(val ?? "") : val === true ? "yes" : val === false ? "no" : ""}
                      onChange={(e) => setVal(opts ? e.target.value : e.target.value === "" ? null : e.target.value === "yes")}
                      data-new-field={d.key}
                    >
                      <option value="">—</option>
                      {opts
                        ? opts.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))
                        : [
                            <option key="yes" value="yes">
                              {t.common.yes}
                            </option>,
                            <option key="no" value="no">
                              {t.common.no}
                            </option>,
                          ]}
                    </Select>
                  </Field>
                );
              }
              if (d.field_type === "longtext") {
                return (
                  <Field key={d.id} label={label} required>
                    <Textarea value={String(val ?? "")} className="min-h-20" onChange={(e) => setVal(e.target.value)} data-new-field={d.key} />
                  </Field>
                );
              }
              return (
                <Field key={d.id} label={label} required>
                  <Input
                    type={d.field_type === "number" ? "number" : d.field_type === "date" ? "date" : d.field_type === "email" ? "email" : "text"}
                    dir={d.field_type === "phone" || d.field_type === "email" ? "ltr" : undefined}
                    value={String(val ?? "")}
                    onChange={(e) => setVal(e.target.value)}
                    data-new-field={d.key}
                  />
                </Field>
              );
            })}
          </div>
          {err?.field === "form" && <p className="text-[0.8125rem] text-danger">{err.text}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setNewOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button onClick={submitNew} loading={pending} disabled={missing} data-new-create>
              {t.common.create}
            </Button>
          </div>
        </div>
      </Modal>

    </>
  );
}

/** An empty cell: a quiet dash, so a column of blanks still reads as a column. */
function Dash() {
  return <span className="text-ink-300">—</span>;
}

/** "3 weeks ago", in the reader's language — how long since, which is what a last visit is read for. */
function ago(iso: string, intl: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(intl, { numeric: "auto" });
  if (days < 1) return rtf.format(0, "day");
  if (days < 7) return rtf.format(-days, "day");
  if (days < 60) return rtf.format(-Math.round(days / 7), "week");
  if (days < 365) return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}

/** "Tue 25 Nov" in the clinic's zone — a coming visit is read by its day. */
function shortDay(iso: string, tz: string, intl: string): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz).setLocale(intl).toFormat("ccc d LLL");
}

/**
 * Everything but the presets, behind one button: tag, source, how long since
 * the last visit, and muted from messages. Native selects inside, so a phone
 * gets its own picker. The count on the button says how many are set; the
 * chips under the search take them off one at a time.
 */
function FilterMenu({
  label,
  count,
  f,
  onChange,
  allTags,
  sources,
  words,
}: {
  label: string;
  count: number;
  f: { q: string; tag: string; source: string; visit: string; optedOut: string; owes: string };
  onChange: (next: FilterMenuProps["f"]) => void;
  allTags: string[];
  sources: Record<string, string>;
  words: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-filters-toggle
        className={buttonClass({ variant: "outline", size: "sm", className: "max-md:h-10" })}
      >
        <SlidersHorizontal className="h-4 w-4" />
        {label}
        {count > 0 && (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brand-600 px-1 text-[length:max(11px,0.6875rem)] font-semibold text-on-brand tnum">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute end-0 top-full z-30 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-card border border-line bg-surface p-3 shadow-pop"
          data-filters-menu
        >
          <Select className="min-w-0" value={f.tag} onChange={(e) => onChange({ ...f, tag: e.target.value })}>
            <option value="">{words.allTags}</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
          <Select className="min-w-0" value={f.source} onChange={(e) => onChange({ ...f, source: e.target.value })}>
            <option value="">{words.allSources}</option>
            {Object.entries(sources).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select className="min-w-0" value={f.visit} onChange={(e) => onChange({ ...f, visit: e.target.value, owes: "" })}>
            <option value="">{words.anyVisit}</option>
            <option value="30">{words.noVisit30}</option>
            <option value="90">{words.noVisit90}</option>
            <option value="180">{words.noVisit180}</option>
          </Select>
          {/* Two states, not three: nobody asks for the list minus the few who opted out — that list is the list. */}
          <Select className="min-w-0" value={f.optedOut} onChange={(e) => onChange({ ...f, optedOut: e.target.value })}>
            <option value="">{words.anyMessaging}</option>
            <option value="1">{words.mutedOnly}</option>
          </Select>
        </div>
      )}
    </div>
  );
}
type FilterMenuProps = { f: { q: string; tag: string; source: string; visit: string; optedOut: string; owes: string } };
