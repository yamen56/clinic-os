"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Upload } from "lucide-react";

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
  const router = useRouter();
  const { toast } = useToast();
  const { patch, state } = useAutosave({
    url: `/api/c/${slug}/clinic`,
    entityKey: `clinic:${slug}`,
  });
  const [color, setColor] = useState(clinic.brand_color);
  const [uploading, setUploading] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const ro = !isOwner;

  const uploadLogo = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(`/api/c/${slug}/clinic/logo`, { method: "POST", body: fd });
      if (!res.ok) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.common.saved);
      router.refresh();
    } finally {
      setUploading(false);
    }
  };

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
            {!ro && (
              <>
                <input
                  ref={logoInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    void uploadLogo(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Button variant="outline" size="sm" loading={uploading} onClick={() => logoInput.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                  Logo
                </Button>
              </>
            )}
          </div>
        </Field>
      </div>
    </Card>
  );
}
