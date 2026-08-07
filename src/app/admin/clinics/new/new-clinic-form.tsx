"use client";

import { useActionState, useState } from "react";
import { createClinicAction } from "../../actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";

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
        error={state?.fieldErrors?.slug ? "This slug is taken — choose another." : undefined}
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
