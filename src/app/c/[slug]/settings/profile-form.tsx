"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { SaveIndicator } from "@/components/ui/save-indicator";

export function ClinicProfileForm({
  slug,
  isOwner,
  clinic,
}: {
  slug: string;
  isOwner: boolean;
  clinic: {
    name: string;
    name_ar: string | null;
    phone_e164: string | null;
    address: string | null;
    address_ar: string | null;
    google_maps_url: string | null;
    brand_color: string;
    default_locale: string;
    timezone: string;
  };
}) {
  const { t } = useI18n();
  const { patch, state } = useAutosave({
    url: `/api/c/${slug}/clinic`,
    entityKey: `clinic:${slug}`,
  });
  const [color, setColor] = useState(clinic.brand_color);
  const ro = !isOwner;

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{t.settings.profile}</h2>
        <SaveIndicator state={state} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.admin.clinicName} required>
          <Input defaultValue={clinic.name} disabled={ro} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label={t.admin.clinicNameAr}>
          <Input dir="rtl" defaultValue={clinic.name_ar ?? ""} disabled={ro} onChange={(e) => patch({ name_ar: e.target.value })} />
        </Field>
        <Field label={t.common.phone}>
          <Input dir="ltr" defaultValue={clinic.phone_e164 ?? ""} disabled={ro} onChange={(e) => patch({ phone_e164: e.target.value })} />
        </Field>
        <Field label={t.settings.languageRegion}>
          <Select defaultValue={clinic.default_locale} disabled={ro} onChange={(e) => patch({ default_locale: e.target.value })}>
            <option value="ar">{t.common.arabic}</option>
            <option value="en">{t.common.english}</option>
          </Select>
        </Field>
        <Field label="Address">
          <Input defaultValue={clinic.address ?? ""} disabled={ro} onChange={(e) => patch({ address: e.target.value })} />
        </Field>
        <Field label="العنوان">
          <Input dir="rtl" defaultValue={clinic.address_ar ?? ""} disabled={ro} onChange={(e) => patch({ address_ar: e.target.value })} />
        </Field>
        <Field label="Google Maps">
          <Input dir="ltr" defaultValue={clinic.google_maps_url ?? ""} disabled={ro} placeholder="https://maps.app.goo.gl/…" onChange={(e) => patch({ google_maps_url: e.target.value })} />
        </Field>
        <Field label={t.settings.branding}>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={color}
              disabled={ro}
              onChange={(e) => {
                setColor(e.target.value);
                patch({ brand_color: e.target.value });
              }}
              className="h-9 w-14 cursor-pointer rounded-md border border-line-strong bg-surface"
            />
            <span dir="ltr" className="text-sm text-ink-500 tnum">{color}</span>
          </div>
        </Field>
      </div>
    </Card>
  );
}
