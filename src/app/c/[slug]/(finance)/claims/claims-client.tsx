"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtMoney, fmtDate } from "@/lib/dates";
import { coverHolds } from "@/lib/insurance";
import type { ClaimRow, InsurerSummary } from "@/lib/claims";
import { PageHeader, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { markClaimsPaidAction, setClaimStatusAction } from "./actions";
import { Download, ShieldCheck, TriangleAlert } from "lucide-react";

const claimBadge: Record<string, StatusKey> = {
  to_submit: "pending",
  submitted: "scheduled",
  approved: "confirmed",
  rejected: "danger",
  paid: "completed",
};

const STATUS_FILTERS = ["open", "to_submit", "submitted", "approved", "rejected", "paid", "all"] as const;

export function ClaimsClient({
  slug,
  currency,
  today,
  filters,
  rows,
  summary,
  insurers,
  canWork,
  canOpenInvoices,
  canOpenPatients,
}: {
  slug: string;
  currency: string;
  today: string;
  filters: { insurerId: string | null; status: string; month: string | null };
  rows: ClaimRow[];
  summary: InsurerSummary[];
  insurers: { id: string; name: string }[];
  /** `insurance.claims`: tick claims, move them along, download the statement. */
  canWork: boolean;
  /** The rows link to screens this member may not open; without them they are text. */
  canOpenInvoices: boolean;
  canOpenPatients: boolean;
}) {
  const { t, locale } = useI18n();
  const T = t.claims;
  const router = useRouter();
  const { toast } = useToast();
  const [navigating, startNav] = useTransition();
  const [working, startWork] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paidOpen, setPaidOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [reason, setReason] = useState("");
  /*
    The filters answer the click, not the server: held here and shown at once,
    while the page behind them catches up. A select that snaps back to its old
    value until the query finishes reads as one that ignored the choice.
  */
  const [f, setF] = useState(filters);
  useEffect(() => setF(filters), [filters]);
  // A new list is a new selection; ids from the old one may no longer be in it.
  useEffect(() => setSelected(new Set()), [rows]);

  const go = (next: typeof f) => {
    setF(next);
    const qs = new URLSearchParams();
    if (next.insurerId) qs.set("insurer", next.insurerId);
    if (next.status && next.status !== "open") qs.set("status", next.status);
    if (next.month) qs.set("month", next.month);
    startNav(() => router.push(`/c/${slug}/claims${qs.size ? `?${qs}` : ""}`));
  };

  const exportHref = useMemo(() => {
    const qs = new URLSearchParams();
    if (f.insurerId) qs.set("insurer", f.insurerId);
    if (f.status) qs.set("status", f.status);
    if (f.month) qs.set("month", f.month);
    return `/api/c/${slug}/claims/export?${qs}`;
  }, [f, slug]);

  const money = (n: number | string) => fmtMoney(Number(n), currency, locale);
  const chosen = rows.filter((r) => selected.has(r.id));
  const chosenTotal = chosen.reduce((s, r) => s + Number(r.insurer_amount), 0);
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setStatus = (status: string, note?: string) =>
    startWork(async () => {
      const r = await setClaimStatusAction(slug, [...selected], status, note);
      if (r.error) return toast(t.common.genericError, "error");
      toast(T.updated.replace("{n}", String(r.updated ?? 0)));
      setSelected(new Set());
      setRejectOpen(false);
      setReason("");
    });

  return (
    <div className={navigating ? "opacity-70 transition-opacity" : undefined}>
      <PageHeader
        title={T.title}
        sub={T.sub}
        action={
          canWork ? (
            <a href={exportHref} className={buttonClass({ variant: "outline", size: "sm" })}>
              <Download className="h-4 w-4" />
              {T.statement}
            </a>
          ) : undefined
        }
      />

      {/*
        Who owes the clinic, and since when — across every open claim, whatever
        the list below is filtered to. A card is also the quickest filter: the
        question after "how much does GlobeMed owe us" is "for what".
      */}
      {summary.length > 0 && (
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {summary.map((s) => (
            <button
              key={s.insurerId}
              onClick={() => go({ ...f, insurerId: f.insurerId === s.insurerId ? null : s.insurerId })}
              className={`rounded-card border bg-surface p-4 text-start transition-colors hover:border-brand-300 ${
                f.insurerId === s.insurerId ? "border-brand-500" : "border-line"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{s.name}</span>
                {s.rejected > 0 && (
                  <Badge status="danger">
                    {s.rejected} {T.rejectedShort}
                  </Badge>
                )}
              </div>
              <div className="mt-1 font-display text-2xl font-bold tnum">{money(s.awaiting)}</div>
              <div className="text-[12px] text-ink-500">
                {T.awaiting} · {s.open} {T.claimsCount}
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1 text-[11px] text-ink-500">
                {(["d30", "d60", "d90", "older"] as const).map((b) => (
                  <div key={b} className={b === "older" && s.aging.older > 0 ? "text-danger" : undefined}>
                    <div>{T.aging[b]}</div>
                    <div className="tnum font-medium text-ink-700">{money(s.aging[b])}</div>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}

      <Card className="mb-4 grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <Field label={t.insurers.insurer}>
          <Select value={f.insurerId ?? ""} onChange={(e) => go({ ...f, insurerId: e.target.value || null })}>
            <option value="">{T.allInsurers}</option>
            {insurers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={T.status}>
          <Select value={f.status} onChange={(e) => go({ ...f, status: e.target.value })}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "open" ? T.open : s === "all" ? T.all : (t.insurers.claimStatus as Record<string, string>)[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={T.month}>
          <Input type="month" dir="ltr" value={f.month ?? ""} onChange={(e) => go({ ...f, month: e.target.value || null })} />
        </Field>
      </Card>

      {rows.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title={T.emptyTitle} body={T.emptyBody} />
      ) : (
        <Card>
          <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[13px] text-ink-500">
            {canWork && (
              <input
                type="checkbox"
                aria-label={T.selectAll}
                checked={allOn}
                onChange={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))}
                className="h-4 w-4 accent-brand-600"
              />
            )}
            <span>{T.count.replace("{n}", String(rows.length))}</span>
          </div>
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const lapsed = !coverHolds(r.insurer_id, r.cover_until, r.issue_day);
              return (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                  {canWork && (
                    <input
                      type="checkbox"
                      aria-label={r.number}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="mt-1 h-4 w-4 accent-brand-600"
                    />
                  )}
                  <div className="grid min-w-0 flex-1 gap-1 sm:grid-cols-[1fr_1.4fr_1fr_auto] sm:items-center sm:gap-4">
                    <div className="min-w-0">
                      {canOpenInvoices ? (
                        <Link href={`/c/${slug}/invoices/${r.id}`} className="text-sm font-semibold hover:text-brand-700" dir="ltr">
                          {r.number}
                        </Link>
                      ) : (
                        <span className="text-sm font-semibold" dir="ltr">
                          {r.number}
                        </span>
                      )}
                      <div className="text-[12px] text-ink-500">{fmtDate(`${r.issue_day}T12:00:00Z`, "UTC", locale)}</div>
                    </div>
                    <div className="min-w-0">
                      {canOpenPatients ? (
                        <Link href={`/c/${slug}/patients/${r.patient_id}`} className="block truncate text-sm hover:text-brand-700">
                          {r.patient_name}
                        </Link>
                      ) : (
                        <span className="block truncate text-sm">{r.patient_name}</span>
                      )}
                      <div className="truncate text-[12px] text-ink-500">
                        {r.national_id ? (
                          <span dir="ltr">{r.national_id}</span>
                        ) : (
                          <span className="text-st-pending">{T.noNationalId}</span>
                        )}
                        {r.insurance_no ? <span dir="ltr"> · {r.insurance_no}</span> : null}
                      </div>
                    </div>
                    <div className="min-w-0 text-[13px]">
                      <div className="truncate">{r.insurer_name ?? "—"}</div>
                      <div className="tnum font-semibold">{money(r.insurer_amount)}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                      <Badge status={claimBadge[r.claim_status] ?? "neutral"}>
                        {(t.insurers.claimStatus as Record<string, string>)[r.claim_status] ?? r.claim_status}
                      </Badge>
                      {lapsed && (
                        <span className="inline-flex items-center gap-1 text-[12px] text-danger" title={T.coverLapsed}>
                          <TriangleAlert className="h-3.5 w-3.5" />
                          {T.coverLapsedShort}
                        </span>
                      )}
                    </div>
                    {r.claim_status === "rejected" && r.claim_note && (
                      <p className="text-[12px] text-danger sm:col-span-4">{r.claim_note}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/*
        The work, on whatever is ticked. Sticky at the bottom so it is in reach
        however far down the list the last tick was.
      */}
      {canWork && selected.size > 0 && (
        <div className="sticky bottom-3 z-20 mt-4 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface p-3 shadow-pop">
          <span className="me-auto text-sm font-medium">
            {T.selected.replace("{n}", String(selected.size))} · <span className="tnum">{money(chosenTotal)}</span>
          </span>
          <Button size="sm" variant="outline" loading={working} onClick={() => setStatus("submitted")}>
            {T.markSubmitted}
          </Button>
          <Button size="sm" variant="outline" loading={working} onClick={() => setStatus("approved")}>
            {T.markApproved}
          </Button>
          <Button size="sm" variant="outline" disabled={working} onClick={() => setRejectOpen(true)}>
            {T.markRejected}
          </Button>
          <Button size="sm" disabled={working} onClick={() => setPaidOpen(true)}>
            {T.markPaid}
          </Button>
        </div>
      )}

      <Modal open={paidOpen} onClose={() => setPaidOpen(false)} title={T.paidTitle}>
        <div className="grid gap-4">
          <p className="text-[13px] text-ink-500">
            {T.paidBody.replace("{n}", String(selected.size)).replace("{amount}", money(chosenTotal))}
          </p>
          <Field label={T.paidReference} hint={T.paidReferenceHint}>
            <Input dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label={T.paidOn}>
            <Input type="date" dir="ltr" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPaidOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              loading={working}
              onClick={() =>
                startWork(async () => {
                  const r = await markClaimsPaidAction(slug, [...selected], { reference, paidOn });
                  if (r.error) return toast(t.common.genericError, "error");
                  toast(T.paidDone.replace("{n}", String(r.paid ?? 0)).replace("{amount}", money(r.amount ?? 0)));
                  setSelected(new Set());
                  setPaidOpen(false);
                  setReference("");
                })
              }
            >
              {T.markPaid}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title={T.rejectTitle}>
        <div className="grid gap-4">
          <Field label={T.rejectReason} hint={T.rejectReasonHint}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button variant="danger" loading={working} onClick={() => setStatus("rejected", reason)}>
              {T.markRejected}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
