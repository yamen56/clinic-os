"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createClinicAction } from "../../actions";
import { lookupOwnerAction } from "../../clinic-actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field, Select } from "@/components/ui/input";
import { FeaturePicker } from "../../feature-picker";
import { PlanPicker } from "../../plan-picker";
import { DepartmentPicker } from "../../department-picker";
import { SpecialtyAdds } from "../../specialty-adds";
import { PLAN_PROFILES, applyPlan, planFeatures, planOverrides, type Plan } from "@/lib/plans";
import { SPECIALTIES, type Specialty } from "@/lib/specialties";
import { SPECIALTY_MODULES, modulesFor } from "@/lib/specialty-profile";
import type { FeatureMap } from "@/lib/features";
import { Check, ChevronDown } from "lucide-react";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 48);
}

const STEPS = ["clinic", "specialty", "plan", "owner", "review"] as const;
type Step = (typeof STEPS)[number];

/**
 * A new clinic, one question at a time (Admin → New clinic, 2026-11-27).
 *
 * Five short steps rather than one long form — the clinic, what it practises,
 * what it bought, who owns it, and a last look — because each answer changes
 * the next: the specialty switches the charts on, the plan decides the modules
 * and the user limit, and the owner's email may already be someone's account.
 *
 * Every input stays mounted whichever step is showing, so the one form posts
 * all of it to `createClinicAction` exactly as before.
 */
export function NewClinicWizard({ prices }: { prices: Record<Plan, number> }) {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(createClinicAction, null);
  const [step, setStep] = useState<Step>("clinic");
  const formRef = useRef<HTMLFormElement>(null);

  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [addressAr, setAddressAr] = useState("");

  const [specialty, setSpecialty] = useState<Specialty>("general");
  const [departments, setDepartments] = useState<Specialty[]>([]);

  const [plan, setPlan] = useState<Plan>("clinic_plus");
  const [features, setFeatures] = useState<FeatureMap>(() => planFeatures("clinic_plus"));
  const [price, setPrice] = useState(String(prices.clinic_plus ?? 0));
  const [priceTouched, setPriceTouched] = useState(false);
  const [status, setStatus] = useState<"trial" | "active">("trial");
  const [trialDays, setTrialDays] = useState("14");
  const [paidUntil, setPaidUntil] = useState("");
  const [modulesOpen, setModulesOpen] = useState(false);

  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerRole, setOwnerRole] = useState<"doctor" | "receptionist" | "other">("doctor");
  const [owner, setOwner] = useState<{ exists: boolean; hasPassword?: boolean; clinics?: string[] } | null>(null);

  // A server refusal on the address sends the agency back to where it is typed.
  useEffect(() => {
    if (state?.fieldErrors?.slug) setStep("clinic");
  }, [state]);

  // The specialty switches the charts it needs on, and the ones no field still needs off — still overridable.
  const follow = (beforeFields: Specialty[], afterFields: Specialty[]) => {
    const before = modulesFor(beforeFields);
    const after = modulesFor(afterFields);
    setFeatures((f) => {
      const next = { ...f };
      for (const m of SPECIALTY_MODULES) {
        if (after.includes(m) && !before.includes(m)) next[m] = true;
        else if (before.includes(m) && !after.includes(m)) next[m] = false;
      }
      return next;
    });
  };
  const pickPlan = (p: Plan) => {
    setPlan(p);
    setFeatures((f) => applyPlan(f, p));
    if (!priceTouched) setPrice(String(prices[p] ?? 0));
  };

  const lookup = async (email: string) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setOwner(null);
    setOwner(await lookupOwnerAction(email.trim()));
  };

  const canLeave: Record<Step, boolean> = {
    clinic: name.trim().length >= 2 && /^[a-z0-9][a-z0-9-]{1,47}$/.test(slug),
    specialty: true,
    plan: true,
    owner: ownerName.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim()),
    review: true,
  };
  const at = STEPS.indexOf(step);
  const go = (d: number) => setStep(STEPS[Math.max(0, Math.min(STEPS.length - 1, at + d))]);
  const diff = planOverrides(features, plan);
  const stepLabel: Record<Step, string> = {
    clinic: t.admin.stepClinic,
    specialty: t.admin.stepSpecialty,
    plan: t.admin.stepPlan,
    owner: t.admin.stepOwner,
    review: t.admin.stepReview,
  };
  const hidden = (s: Step) => (step === s ? "grid gap-4" : "hidden");

  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid gap-5"
      data-new-clinic-wizard
      // Enter moves on a step; only the last step's button creates the clinic.
      onKeyDown={(e) => {
        if (e.key !== "Enter" || step === "review" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
        e.preventDefault();
        if (canLeave[step]) go(1);
      }}
    >
      {/* Where you are, and a way back to any step already done. */}
      <ol className="flex flex-wrap items-center gap-1.5" aria-label={t.admin.newClinic}>
        {STEPS.map((s, i) => {
          const done = i < at;
          const here = i === at;
          return (
            <li key={s}>
              <button
                type="button"
                disabled={i > at}
                onClick={() => setStep(s)}
                data-step={s}
                data-step-here={here ? "1" : undefined}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.8125rem] font-medium transition-colors ${
                  here ? "bg-brand-600 text-on-brand" : done ? "bg-brand-100 text-brand-700" : "bg-sunken text-ink-400"
                }`}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : <span className="tnum">{i + 1}</span>}
                {stepLabel[s]}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="rounded-card border border-line bg-surface p-5 shadow-card sm:p-6">
        {/* 1. The clinic */}
        <div className={hidden("clinic")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.admin.clinicName} required>
              <Input
                name="name"
                value={name}
                autoFocus
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            </Field>
            <Field label={t.admin.clinicNameAr}>
              <Input name="nameAr" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
            </Field>
          </div>
          <Field
            label={t.admin.slug}
            required
            hint={slug ? `/${slug}` : undefined}
            error={
              state?.fieldErrors?.slug === "reserved"
                ? "That address is reserved by the platform — choose another."
                : state?.fieldErrors?.slug
                  ? "This slug is taken — choose another."
                  : undefined
            }
          >
            <Input
              name="slug"
              dir="ltr"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value));
              }}
            />
          </Field>
          <Field label={t.common.phone}>
            <Input name="phone" dir="ltr" value={phone} placeholder="07xxxxxxxx" onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.admin.address}>
              <Input name="address" value={address} onChange={(e) => setAddress(e.target.value)} />
            </Field>
            <Field label={t.admin.addressAr}>
              <Input name="addressAr" dir="rtl" value={addressAr} onChange={(e) => setAddressAr(e.target.value)} />
            </Field>
          </div>
        </div>

        {/* 2. What it practises */}
        <div className={hidden("specialty")}>
          <Field label={t.admin.specialty} hint={t.admin.specialtySub}>
            <Select
              name="specialty"
              value={specialty}
              onChange={(e) => {
                const v = e.target.value as Specialty;
                follow([specialty, ...departments], [v, ...departments]);
                setSpecialty(v);
              }}
            >
              {SPECIALTIES.map((s) => (
                <option key={s} value={s}>
                  {t.specialties[s]}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <div className="mb-1 text-sm font-medium text-ink-900">{t.admin.departments}</div>
            <p className="mb-2.5 text-[0.8125rem] text-ink-500">{t.admin.departmentsSub}</p>
            <DepartmentPicker
              value={departments}
              onChange={(v) => {
                follow([specialty, ...departments], [specialty, ...v]);
                setDepartments(v);
              }}
              primary={specialty}
              disabled={pending}
            />
            <input type="hidden" name="departments" value={departments.filter((d) => d !== specialty).join(",")} />
          </div>
          <SpecialtyAdds specialties={[specialty, ...departments.filter((d) => d !== specialty)]} />
        </div>

        {/* 3. What it bought */}
        <div className={hidden("plan")}>
          <PlanPicker value={plan} onChange={pickPlan} disabled={pending} name="plan" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.admin.planPrice}>
              <Input
                name="planPrice"
                dir="ltr"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => {
                  setPriceTouched(true);
                  setPrice(e.target.value);
                }}
              />
            </Field>
            <Field label={t.plans.memberLimit} hint={t.plans.memberLimitHint}>
              <Input name="memberLimit" dir="ltr" type="number" min={1} step={1} placeholder={String(planFeaturesLimit(plan))} />
            </Field>
          </div>
          <Field label={t.admin.startsAs}>
            <div className="flex flex-wrap items-center gap-2">
              {(["trial", "active"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setStatus(v)}
                  data-start-as={v}
                  className={`rounded-full px-3 py-1.5 text-[0.8125rem] font-medium ${
                    status === v ? "bg-brand-600 text-on-brand" : "bg-sunken text-ink-700"
                  }`}
                >
                  {v === "trial" ? t.admin.trial : t.admin.activeNow}
                </button>
              ))}
            </div>
            <input type="hidden" name="status" value={status} />
          </Field>
          {status === "trial" ? (
            <Field label={t.admin.trialDays}>
              <Input name="trialDays" dir="ltr" type="number" min={0} max={365} value={trialDays} onChange={(e) => setTrialDays(e.target.value)} />
            </Field>
          ) : (
            <Field label={t.admin.paidUntil}>
              <Input name="paidUntil" dir="ltr" type="date" value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} />
            </Field>
          )}
          <div className="rounded-lg border border-line">
            <button
              type="button"
              onClick={() => setModulesOpen((o) => !o)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-start text-[0.8125rem] font-medium text-ink-700"
              data-customise-modules
            >
              <span>
                {t.admin.customiseModules}
                {(diff.added.length > 0 || diff.removed.length > 0) && (
                  <span className="ms-2 text-ink-500">
                    {diff.added.length > 0 && `+${diff.added.length} `}
                    {diff.removed.length > 0 && `−${diff.removed.length}`}
                  </span>
                )}
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${modulesOpen ? "rotate-180" : ""}`} />
            </button>
            {/* Mounted closed too: the module list is what the form posts. */}
            <div className={modulesOpen ? "border-t border-line p-3" : "hidden"}>
              <FeaturePicker value={features} onChange={setFeatures} disabled={pending} plan={plan} />
            </div>
          </div>
        </div>

        {/* 4. Who owns it */}
        <div className={hidden("owner")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.admin.ownerName} required>
              <Input name="ownerName" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            </Field>
            <Field label={t.admin.ownerRole}>
              <Select name="ownerRole" value={ownerRole} onChange={(e) => setOwnerRole(e.target.value as typeof ownerRole)}>
                {(["doctor", "receptionist", "other"] as const).map((r) => (
                  <option key={r} value={r}>
                    {t.staff.roles[r]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t.admin.ownerEmail} required>
            <Input
              name="ownerEmail"
              type="email"
              dir="ltr"
              value={ownerEmail}
              onChange={(e) => {
                setOwnerEmail(e.target.value);
                setOwner(null);
              }}
              onBlur={(e) => void lookup(e.target.value)}
              data-owner-email
            />
          </Field>
          {/*
            Said before the clinic is made: one email is one account across
            every clinic on Clinicti, so an owner who already has one signs in
            with the password they have and is told they were added.
          */}
          {owner?.exists ? (
            <p className="rounded-md bg-brand-50 px-3 py-2 text-[0.8125rem] text-ink-700" data-owner-exists>
              {owner.hasPassword
                ? t.admin.ownerExists.replace("{clinics}", (owner.clinics ?? []).join("، ") || "—")
                : t.admin.ownerExistsNew}
            </p>
          ) : (
            <p className="rounded-md bg-sunken px-3 py-2 text-[0.8125rem] text-ink-500">{t.admin.ownerInviteHint}</p>
          )}
        </div>

        {/* 5. A last look */}
        <div className={hidden("review")}>
          <h3 className="text-sm font-semibold text-ink-900">{t.admin.reviewTitle}</h3>
          <dl className="grid gap-2 text-sm" data-review>
            {(
              [
                [t.admin.clinicName, nameAr ? `${name} · ${nameAr}` : name],
                [t.admin.slug, `/${slug}`],
                [t.admin.specialty, [specialty, ...departments.filter((d) => d !== specialty)].map((s) => t.specialties[s]).join("، ")],
                [t.admin.plan, `${t.plans.names[plan]} · ${price || 0}`],
                [t.admin.startsAs, status === "trial" ? `${t.admin.trial} · ${trialDays}` : `${t.admin.activeNow}${paidUntil ? ` · ${paidUntil}` : ""}`],
                [t.admin.stepOwner, `${ownerName} · ${ownerEmail} · ${t.staff.roles[ownerRole]}`],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-line pb-2 last:border-0">
                <dt className="shrink-0 text-ink-500">{k}</dt>
                <dd className="min-w-0 text-end text-ink-900" dir="auto">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {state?.error && (
            <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{t.common.genericError}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" onClick={() => go(-1)} disabled={at === 0 || pending}>
          {t.admin.back}
        </Button>
        {/*
          Two keys, so two elements. One button switching from "button" to
          "submit" inside its own click is submitted by the browser at once —
          Next on the owner step created the clinic without the review.
        */}
        {step === "review" ? (
          <Button key="create" type="submit" size="lg" loading={pending} data-create-clinic>
            {t.admin.createClinic}
          </Button>
        ) : (
          <Button key="next" type="button" onClick={() => go(1)} disabled={!canLeave[step]} data-next-step>
            {t.admin.next}
          </Button>
        )}
      </div>
    </form>
  );
}

/** The placeholder under "User limit": the plan's own number, or ∞. */
function planFeaturesLimit(plan: Plan): string {
  return String(PLAN_PROFILES[plan].memberLimit ?? "∞");
}
