"use client";

import { useActionState, useState } from "react";
import { createClinicAction } from "../../actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field, Select } from "@/components/ui/input";
import { FeaturePicker } from "../../feature-picker";
import { allFeatures } from "@/lib/features";
import { SPECIALTIES } from "@/lib/specialties";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 48);
}

export function NewClinicForm() {
  const { t } = useI18n();
  const [state, formAction, pending] = useActionState(createClinicAction, null);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  /*
    Everything on, and the agency takes away what this clinic did not buy.
    Starting from nothing would make the common case — a clinic buying the
    product — eight clicks of ceremony, and would make a forgotten switch look
    exactly like a deliberate one.
  */
  const [features, setFeatures] = useState(allFeatures());

  return (
    <form
      action={formAction}
      className="grid gap-4 rounded-card border border-line bg-surface p-6 shadow-card"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.admin.clinicName} required>
          <Input
            name="name"
            required
            onChange={(e) => {
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label={t.admin.clinicNameAr}>
          <Input name="nameAr" dir="rtl" />
        </Field>
      </div>
      <Field
        label={t.admin.slug}
        required
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
          required
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(slugify(e.target.value));
          }}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.common.phone}>
          <Input name="phone" dir="ltr" placeholder="0790744070" />
        </Field>
        <Field label={t.admin.planPrice}>
          <Input name="planPrice" dir="ltr" type="number" min={0} step="0.01" defaultValue={0} />
        </Field>
      </div>
      {/*
        Asked here rather than left to the clinic, because the answer is only
        useful on the day the workspace is built: it decides which recipes are
        copied in, and after that it is a label. The agency knows it — they just
        sold to them.
      */}
      <Field label={t.admin.specialty} hint={t.admin.specialtySub}>
        <Select name="specialty" defaultValue="general">
          {SPECIALTIES.map((s) => (
            <option key={s} value={s}>
              {t.specialties[s]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="my-1 border-t border-line" />
      <div>
        <div className="mb-1 text-sm font-medium text-ink-900">{t.admin.features}</div>
        <p className="mb-2.5 text-[13px] text-ink-500">{t.admin.featuresSub}</p>
        <FeaturePicker value={features} onChange={setFeatures} disabled={pending} />
      </div>
      <div className="my-1 border-t border-line" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.admin.ownerName} required>
          <Input name="ownerName" required />
        </Field>
        <Field label={t.admin.ownerEmail} required>
          <Input name="ownerEmail" type="email" dir="ltr" required />
        </Field>
      </div>
      {/* Says what will happen, because the missing password field is otherwise
          the most obvious thing about this form. */}
      <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-500">
        {t.admin.ownerInviteHint}
      </p>
      {state?.error && (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {t.common.genericError}
        </p>
      )}
      <Button type="submit" size="lg" loading={pending}>
        {t.admin.createClinic}
      </Button>
    </form>
  );
}
