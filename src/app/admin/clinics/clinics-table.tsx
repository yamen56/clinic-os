"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { arFold } from "@/lib/ar-fold";
import { fmtRelative } from "@/lib/dates";
import { PLANS, type Plan } from "@/lib/plans";
import type { Feature } from "@/lib/features";
import { Search } from "lucide-react";

export type ClinicRow = {
  id: string;
  name: string;
  nameAr: string | null;
  slug: string;
  status: string;
  plan: Plan;
  /** Modules the agency switched on or off against the plan. */
  added: Feature[];
  removed: Feature[];
  price: number;
  currency: string;
  specialty: string;
  members: number;
  memberLimit: number | null;
  waStatus: string | null;
  failedRuns: number;
  lastActivity: string | null;
  trialEnds: string | null;
  owner: { name: string; email: string; phone: string | null; pending: boolean } | null;
  phone: string | null;
  address: string;
  attention: boolean;
};

const subStatus: Record<string, StatusKey> = {
  trial: "pending",
  active: "confirmed",
  past_due: "no_show",
  suspended: "cancelled",
};

/**
 * The clinics, searchable on everything the agency is likely to have in hand
 * when a clinic calls — its name in either language, its address, its owner's
 * email or phone — with three presets and one menu (few options, compact
 * figures): All, On trial, Needs attention, and a plan.
 */
export function ClinicsTable({
  rows,
  initialPlan = "",
  initialQuery = "",
}: {
  rows: ClinicRow[];
  initialPlan?: Plan | "";
  initialQuery?: string;
}) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState(initialQuery);
  const [preset, setPreset] = useState<"all" | "trial" | "attention">("all");
  const [plan, setPlan] = useState<Plan | "">(initialPlan);

  const shown = useMemo(() => {
    const needle = arFold(q.trim());
    const digits = q.replace(/\D/g, "");
    return rows.filter((r) => {
      if (preset === "trial" && r.status !== "trial") return false;
      if (preset === "attention" && !r.attention) return false;
      if (plan && r.plan !== plan) return false;
      if (!needle) return true;
      const hay = arFold([r.name, r.nameAr, r.slug, r.address, r.owner?.name, r.owner?.email].filter(Boolean).join(" "));
      if (hay.includes(needle)) return true;
      return digits.length >= 4 && [r.phone, r.owner?.phone].some((p) => (p ?? "").replace(/\D/g, "").includes(digits));
    });
  }, [rows, q, preset, plan]);

  const statusLabel: Record<string, string> = {
    trial: t.admin.trial,
    active: t.admin.activeSub,
    past_due: t.admin.pastDue,
    suspended: t.admin.suspended,
  };
  const chip = (on: boolean) =>
    `rounded-full px-3 py-1.5 text-[0.8125rem] font-medium transition-colors ${
      on ? "bg-brand-600 text-on-brand" : "bg-sunken text-ink-700 hover:text-ink-900"
    }`;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.admin.searchClinics}
            className="!ps-9"
            data-clinic-search
          />
        </label>
        <div className="flex items-center gap-1.5">
          <button type="button" className={chip(preset === "all")} onClick={() => setPreset("all")}>
            {t.admin.filterAll}
          </button>
          <button type="button" className={chip(preset === "trial")} onClick={() => setPreset("trial")}>
            {t.admin.filterTrial}
          </button>
          <button
            type="button"
            className={chip(preset === "attention")}
            onClick={() => setPreset("attention")}
            data-filter-attention
          >
            {t.admin.filterAttention}
          </button>
        </div>
        <Select
          value={plan}
          onChange={(e) => setPlan(e.target.value as Plan | "")}
          aria-label={t.admin.plan}
          className="!w-auto"
          data-plan-filter
        >
          <option value="">{t.admin.plansNav}</option>
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {t.plans.names[p]}
            </option>
          ))}
        </Select>
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-500">{t.admin.noMatches}</p>
      ) : (
        <div className="grid gap-2" data-clinic-list>
          {shown.map((r) => (
            <Link key={r.id} href={`/admin/clinics/${r.slug}`} data-clinic-row={r.slug}>
              <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 transition-shadow hover:shadow-pop">
                <Avatar name={r.name} size={40} />
                <div className="min-w-44 flex-1">
                  <div className="font-medium text-ink-900">{(locale === "ar" ? r.nameAr : null) || r.name}</div>
                  <div className="flex flex-wrap gap-x-2 text-[0.75rem] text-ink-500">
                    <span dir="ltr">/{r.slug}</span>
                    {r.owner && (
                      <span dir="ltr" className="truncate">
                        {r.owner.email}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge status="brand">
                    {t.plans.names[r.plan]}
                    {r.added.length > 0 && ` +${r.added.length}`}
                    {r.removed.length > 0 && ` −${r.removed.length}`}
                  </Badge>
                  <Badge status={subStatus[r.status] ?? "neutral"}>{statusLabel[r.status] ?? r.status}</Badge>
                  <Badge status={r.memberLimit !== null && r.members > r.memberLimit ? "danger" : "neutral"}>
                    <span className="tnum">
                      {r.memberLimit === null ? r.members : `${r.members}/${r.memberLimit}`}
                    </span>{" "}
                    {t.plans.users}
                  </Badge>
                  <Badge status={r.waStatus === "connected" ? "ok" : "danger"} dot>
                    {t.dashboard.whatsapp}
                  </Badge>
                  {r.failedRuns > 0 && <Badge status="danger">{r.failedRuns} ⚠</Badge>}
                  {r.owner?.pending && <Badge status="pending">{t.admin.pendingInvite}</Badge>}
                </div>
                <div className="w-24 text-end text-[0.75rem] text-ink-400 max-sm:w-auto max-sm:text-start">
                  {r.lastActivity ? fmtRelative(r.lastActivity, locale) : "—"}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
