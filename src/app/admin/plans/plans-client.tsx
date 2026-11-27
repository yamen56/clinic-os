"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { PLANS, PLAN_PROFILES, planAdds, type Plan } from "@/lib/plans";
import { FEATURE_ICONS } from "../feature-picker";
import { savePlanPricesAction } from "../clinic-actions";

export function PlansClient({
  prices,
  counts,
  canEdit,
}: {
  prices: Record<Plan, { price: number; currency: string }>;
  counts: Record<Plan, number>;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(PLANS.map((p) => [p, String(prices[p].price)])) as Record<Plan, string>
  );
  const dirty = PLANS.some((p) => Number(draft[p]) !== prices[p].price);

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 lg:grid-cols-3">
        {PLANS.map((p) => {
          const limit = PLAN_PROFILES[p].memberLimit;
          return (
            <Card key={p} className="grid content-start gap-3 p-5" data-plan={p}>
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold text-ink-900">{t.plans.names[p]}</h2>
                <Link href={`/admin/clinics?plan=${p}`} className="text-[0.8125rem] text-ink-500 hover:text-ink-900 tnum">
                  {t.admin.onPlan.replace("{n}", String(counts[p]))}
                </Link>
              </div>
              <p className="text-[0.8125rem] leading-relaxed text-ink-500">{t.plans.blurbs[p]}</p>
              <div className="flex items-center justify-between rounded-lg bg-sunken px-3 py-2 text-[0.8125rem]">
                <span className="text-ink-500">{t.plans.users}</span>
                <span className="font-semibold tnum">{limit ?? t.plans.unlimited}</span>
              </div>
              <div>
                <div className="eyebrow mb-1.5">{p === "doctor" ? t.plans.includes : t.plans.adds}</div>
                <ul className="grid gap-1.5">
                  {planAdds(p).map((f) => {
                    const Icon = FEATURE_ICONS[f];
                    return (
                      <li key={f} className="flex items-center gap-2 text-[0.8125rem] text-ink-700">
                        <Icon className="h-4 w-4 shrink-0 text-brand-700" strokeWidth={1.75} />
                        {t.caps[f]}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <Field label={`${t.admin.defaultPrice} (${prices[p].currency})`}>
                <Input
                  dir="ltr"
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft[p]}
                  disabled={!canEdit || pending}
                  onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
                  data-plan-price={p}
                />
              </Field>
            </Card>
          );
        })}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.8125rem] text-ink-500">{t.admin.defaultPriceHint}</p>
          <Button
            disabled={!dirty}
            loading={pending}
            data-save-prices
            onClick={() =>
              start(async () => {
                const r = await savePlanPricesAction(
                  Object.fromEntries(PLANS.map((p) => [p, Math.max(0, Number(draft[p]) || 0)])) as Record<Plan, number>
                );
                toast(r.error ? t.common.genericError : t.admin.pricesSaved, r.error ? "error" : "success");
              })
            }
          >
            {t.common.save}
          </Button>
        </div>
      )}
    </div>
  );
}
