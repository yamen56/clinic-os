"use client";

import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { PlanPicker } from "../../plan-picker";
import { FeaturePicker } from "../../feature-picker";
import { setClinicPlanAction, updateClinicFeaturesAction, updateSubscriptionAction } from "../../actions";
import { PLAN_PROFILES, applyPlan, planOverrides, type Plan } from "@/lib/plans";
import { toFeatureSetting, type FeatureMap } from "@/lib/features";
import { ChevronDown } from "lucide-react";

export type Billing = {
  plan: Plan;
  memberLimit: number | null;
  status: string;
  price: number;
  currency: string;
  trialEndsAt: string | null;
  paidUntil: string | null;
  notes: string;
  features: FeatureMap;
};

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/**
 * What the clinic bought and what it owes (Admin → clinic → Plan & billing).
 *
 * The plan, its price and dates are one save. The modules are a second,
 * folded under the plan: they are the agency's exceptions to it, and an
 * exception should take a deliberate click, not ride along with a price.
 */
export function PlanBilling({
  clinicId,
  initial,
  canPlan,
  canBill,
}: {
  clinicId: string;
  initial: Billing;
  /** clinics.features: the plan and its modules. */
  canPlan: boolean;
  /** clinics.edit: status, price, dates, notes. */
  canBill: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [saved, setSaved] = useState(initial);
  const [plan, setPlan] = useState<Plan>(initial.plan);
  const limitIsOwn = initial.memberLimit !== PLAN_PROFILES[initial.plan].memberLimit;
  const [limit, setLimit] = useState(limitIsOwn && initial.memberLimit !== null ? String(initial.memberLimit) : "");
  const [status, setStatus] = useState(initial.status);
  const [price, setPrice] = useState(String(initial.price));
  const [trialEnds, setTrialEnds] = useState(day(initial.trialEndsAt));
  const [paidUntil, setPaidUntil] = useState(day(initial.paidUntil));
  const [notes, setNotes] = useState(initial.notes);
  const [features, setFeatures] = useState(initial.features);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [pending, start] = useTransition();
  const [featPending, startFeat] = useTransition();
  const diff = planOverrides(saved.features, saved.plan);

  const save = () =>
    start(async () => {
      if (canBill) {
        await updateSubscriptionAction(clinicId, {
          status,
          planPrice: Number(price) || 0,
          trialEndsAt: trialEnds || null,
          paidUntil: paidUntil || null,
          adminNotes: notes,
        });
      }
      const ownLimit = limit.trim() === "" ? undefined : Math.max(1, Math.round(Number(limit) || 1));
      const limitChanged = (ownLimit ?? PLAN_PROFILES[plan].memberLimit) !== saved.memberLimit;
      let next = { ...saved, status, price: Number(price) || 0, trialEndsAt: trialEnds || null, paidUntil: paidUntil || null, notes };
      // The plan only when it, or its limit, changed: re-applying it would wipe the agency's module exceptions.
      if (canPlan && (plan !== saved.plan || limitChanged)) {
        const r = await setClinicPlanAction(clinicId, plan, { memberLimit: ownLimit });
        if (r.error) return toast(t.common.genericError, "error");
        const f = applyPlan(saved.features, plan);
        setFeatures(f);
        next = { ...next, plan, memberLimit: r.memberLimit ?? null, features: f };
        if (r.paused?.length) toast(t.plans.paused.replace("{names}", r.paused.join("، ")), "error");
        if (r.memberLimit != null && (r.members ?? 0) > r.memberLimit) {
          toast(t.plans.overLimit.replace("{n}", String(r.members)).replace("{limit}", String(r.memberLimit)), "error");
        }
      }
      setSaved(next);
      toast(t.admin.planSaved);
    });

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title={t.admin.tabPlan} />
        <div className="grid gap-4 px-5 pb-5" data-plan-billing>
          <PlanPicker value={plan} onChange={setPlan} disabled={!canPlan || pending} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t.plans.memberLimit} hint={t.plans.memberLimitHint}>
              <Input
                dir="ltr"
                type="number"
                min={1}
                value={limit}
                disabled={!canPlan || pending}
                placeholder={String(PLAN_PROFILES[plan].memberLimit ?? "∞")}
                onChange={(e) => setLimit(e.target.value)}
                data-member-limit
              />
            </Field>
            <Field label={`${t.admin.planPrice} (${initial.currency})`}>
              <Input dir="ltr" type="number" min={0} step="0.01" value={price} disabled={!canBill || pending} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label={t.common.status} hint={status !== saved.status && (status === "past_due" || status === "suspended") ? t.admin.statusEmailsOwner : undefined}>
              <Select value={status} disabled={!canBill || pending} onChange={(e) => setStatus(e.target.value)} data-sub-status>
                <option value="trial">{t.admin.trial}</option>
                <option value="active">{t.admin.activeSub}</option>
                <option value="past_due">{t.admin.pastDue}</option>
                <option value="suspended">{t.admin.suspended}</option>
              </Select>
            </Field>
            <Field label={t.admin.trialEnds}>
              <Input dir="ltr" type="date" value={trialEnds} disabled={!canBill || pending} onChange={(e) => setTrialEnds(e.target.value)} />
            </Field>
            <Field label={t.admin.paidUntil}>
              <Input dir="ltr" type="date" value={paidUntil} disabled={!canBill || pending} onChange={(e) => setPaidUntil(e.target.value)} data-paid-until />
            </Field>
          </div>
          <Field label={t.admin.adminNotes} hint={t.admin.adminNotesHint}>
            <Textarea rows={3} value={notes} disabled={!canBill || pending} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {(canBill || canPlan) && (
            <div className="flex justify-end">
              <Button onClick={save} loading={pending} data-save-plan>
                {t.common.save}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {canPlan && (
        <Card>
          <button
            type="button"
            onClick={() => setModulesOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 px-5 py-4 text-start"
            data-adjust-modules
          >
            <span>
              <span className="block text-sm font-semibold text-ink-900">{t.admin.customiseModules}</span>
              <span className="block text-[0.75rem] text-ink-500">
                {diff.added.length + diff.removed.length === 0
                  ? t.plans.names[saved.plan]
                  : [
                      ...diff.added.map((f) => `+ ${t.caps[f]}`),
                      ...diff.removed.map((f) => `− ${t.caps[f]}`),
                    ].join(" · ")}
              </span>
            </span>
            <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${modulesOpen ? "rotate-180" : ""}`} />
          </button>
          {modulesOpen && (
            <div className="grid gap-3 border-t border-line px-5 py-4">
              <p className="text-[0.8125rem] text-ink-500">{t.admin.featuresSub}</p>
              <FeaturePicker value={features} onChange={setFeatures} disabled={featPending} plan={saved.plan} />
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setFeatures(saved.features)} disabled={featPending}>
                  {t.common.cancel}
                </Button>
                <Button
                  loading={featPending}
                  data-save-modules
                  onClick={() =>
                    startFeat(async () => {
                      const r = await updateClinicFeaturesAction(clinicId, toFeatureSetting(features));
                      if (r.error) return toast(t.common.genericError, "error");
                      setSaved((s) => ({ ...s, features }));
                      if (r.paused?.length) toast(t.plans.paused.replace("{names}", r.paused.join("، ")), "error");
                      else toast(t.admin.featuresSaved);
                    })
                  }
                >
                  {t.common.save}
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
