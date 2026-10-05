"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtMoney } from "@/lib/dates";
import { coverState, hasRule, ruleOf, OPEN_CLAIM_STATUSES } from "@/lib/insurance";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Camera, FileText, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";

export type InsurerOption = {
  id: string;
  name: string;
  coverage_percent: string | null;
  coverage_cap: string | null;
};

export type PatientClaim = {
  id: string;
  number: string;
  issue_day: string | null;
  insurer_amount: string;
  claim_status: string;
  insurer_name: string | null;
};

type CardFile = { id: string; file_name: string; mime_type: string };

const claimBadge: Record<string, StatusKey> = {
  to_submit: "pending",
  submitted: "scheduled",
  approved: "confirmed",
  rejected: "danger",
  paid: "completed",
};

/** A date-only string shown as the clinic's calendar day, never shifted a day by a timezone. */
const day = (d: string, locale: string) => fmtDate(`${d.slice(0, 10)}T12:00:00Z`, "UTC", locale);

/**
 * The patient's insurance, as the desk needs it: who covers them, whether that
 * still holds today, what the company pays, the card itself, and what is
 * still being claimed for them.
 *
 * One card rather than three fields among the personal details, because the
 * question at the desk — "how much does this person pay today" — needs all of
 * it at once, and an expired cover discovered after the claim is rejected is
 * the failure this exists to prevent.
 */
export function InsuranceCard({
  slug,
  patientId,
  currency,
  today,
  insurerId,
  insuranceNo,
  coverUntil,
  insurers,
  cardFiles,
  claims,
  onInsurer,
  onPolicy,
  onValidUntil,
}: {
  slug: string;
  patientId: string;
  currency: string;
  /** The clinic's today, yyyy-MM-dd. */
  today: string;
  insurerId: string | null;
  insuranceNo: string;
  coverUntil: string | null;
  insurers: InsurerOption[];
  cardFiles: CardFile[];
  /** This patient's claims, or null for a member who may not see invoices. */
  claims: PatientClaim[] | null;
  onInsurer: (id: string | null) => void;
  onPolicy: (v: string) => void;
  onValidUntil: (v: string) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.insurers.card;
  const router = useRouter();
  const { toast } = useToast();
  // Held here so the line above the fields answers the edit as it is typed.
  const [until, setUntil] = useState(coverUntil?.slice(0, 10) ?? "");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const insurer = insurers.find((i) => i.id === insurerId) ?? null;
  const state = coverState(insurerId, until || null, today);
  const rule = ruleOf(insurer);
  const daysLeft = until
    ? Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
    : null;

  const open = (claims ?? []).filter((c) => (OPEN_CLAIM_STATUSES as readonly string[]).includes(c.claim_status));
  const owed = open
    .filter((c) => c.claim_status !== "rejected")
    .reduce((s, c) => s + Number(c.insurer_amount), 0);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("kind", "insurance_card");
        const res = await fetch(`/api/c/${slug}/patients/${patientId}/files`, { method: "POST", body: fd });
        if (res.status === 413) toast(t.patients.files.tooLarge, "error");
        else if (!res.ok) toast(t.common.genericError, "error");
      }
      router.refresh();
    } finally {
      setUploading(false);
    }
  };

  const banner =
    state === "none"
      ? { icon: <ShieldOff className="h-4 w-4" />, cls: "bg-sunken text-ink-500", text: T.selfPaying }
      : state === "expired"
        ? {
            icon: <ShieldAlert className="h-4 w-4" />,
            cls: "bg-danger-soft text-danger",
            text: T.expired.replace("{date}", day(until, locale)),
          }
        : state === "expiring"
          ? {
              icon: <ShieldAlert className="h-4 w-4" />,
              cls: "bg-st-pending-soft text-st-pending",
              text: T.expiring.replace("{date}", day(until, locale)).replace("{n}", String(Math.max(0, daysLeft ?? 0))),
            }
          : {
              icon: <ShieldCheck className="h-4 w-4" />,
              cls: "bg-st-confirmed-soft text-st-confirmed",
              text: until ? T.activeUntil.replace("{date}", day(until, locale)) : T.active,
            };

  return (
    <Card className="p-5">
      <h3 className="mb-3 text-[15px] font-semibold">{T.title}</h3>

      <p className={`mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] font-medium ${banner.cls}`}>
        <span className="mt-0.5 shrink-0">{banner.icon}</span>
        <span>{banner.text}</span>
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.insurers.insurer}>
          <Select value={insurerId ?? ""} onChange={(e) => onInsurer(e.target.value || null)}>
            <option value="">{t.insurers.none}</option>
            {insurers.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.insurers.policyNo}>
          <Input dir="ltr" defaultValue={insuranceNo ?? ""} onChange={(e) => onPolicy(e.target.value)} />
        </Field>
        <Field label={t.insurers.validUntil}>
          <Input
            type="date"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
              onValidUntil(e.target.value);
            }}
          />
        </Field>
      </div>

      {insurer && (
        <p className="mt-3 text-[13px] text-ink-500">
          {hasRule(rule)
            ? T.terms
                .replace("{insurer}", insurer.name)
                .replace("{pct}", String(rule.percent))
                .concat(
                  rule.cap !== null
                    ? ` ${T.termsCap.replace("{cap}", fmtMoney(rule.cap, currency, locale))}`
                    : ""
                )
            : T.noTerms}
        </p>
      )}

      {insurerId && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-[13px] font-semibold text-ink-500">{T.cardPhotos}</h4>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => {
                void upload(e.target.files);
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="outline" loading={uploading} onClick={() => fileInput.current?.click()}>
              <Camera className="h-4 w-4" />
              {T.addCard}
            </Button>
          </div>
          {cardFiles.length === 0 ? (
            <p className="text-[13px] text-ink-400">{T.noCard}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {cardFiles.map((f) => (
                <a
                  key={f.id}
                  href={`/api/c/${slug}/files/${f.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block h-24 w-36 overflow-hidden rounded-lg border border-line bg-sunken"
                  title={f.file_name}
                >
                  {f.mime_type.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/c/${slug}/files/${f.id}`} alt={f.file_name} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center gap-1 text-[12px] text-ink-500">
                      <FileText className="h-4 w-4" />
                      PDF
                    </span>
                  )}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {claims && claims.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-[13px] font-semibold text-ink-500">{T.claims}</h4>
            {owed > 0 && (
              <span className="text-[13px] text-ink-500">
                {T.owed} <span className="tnum font-semibold text-ink-900">{fmtMoney(owed, currency, locale)}</span>
              </span>
            )}
          </div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {claims.slice(0, 8).map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <Link href={`/c/${slug}/invoices/${c.id}`} className="font-medium hover:text-brand-700" dir="ltr">
                  {c.number}
                </Link>
                {c.issue_day && <span className="text-ink-400">{day(c.issue_day, locale)}</span>}
                <span className="me-auto truncate text-ink-500">{c.insurer_name}</span>
                <span className="tnum font-semibold">{fmtMoney(Number(c.insurer_amount), currency, locale)}</span>
                <Badge status={claimBadge[c.claim_status] ?? "neutral"}>
                  {(t.insurers.claimStatus as Record<string, string>)[c.claim_status] ?? c.claim_status}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
