"use client";

import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { updateClinicDetailsAction } from "../../clinic-actions";

export type ClinicDetails = {
  name: string;
  nameAr: string;
  phone: string;
  address: string;
  addressAr: string;
  mapsUrl: string;
  timezone: string;
  currency: string;
  defaultLocale: "ar" | "en";
  dailyCap: number;
};

/** The zones and currencies a clinic here is likely to need; anything else is typed. */
const ZONES = ["Asia/Amman", "Asia/Riyadh", "Asia/Dubai", "Asia/Kuwait", "Asia/Qatar", "Asia/Bahrain", "Asia/Baghdad", "Africa/Cairo", "Asia/Beirut", "Europe/Istanbul"];
const CURRENCIES = ["JOD", "SAR", "AED", "KWD", "QAR", "BHD", "OMR", "IQD", "EGP", "USD"];

/**
 * The clinic's own details, from the agency's side (Admin → clinic → Details).
 * What the owner edits under Settings → Clinic profile, plus the WhatsApp
 * daily limit — so onboarding a clinic no longer needs a support visit to type
 * its address. The web address is shown and not editable.
 */
export function DetailsForm({ clinicId, slug, initial, canEdit }: { clinicId: string; slug: string; initial: ClinicDetails; canEdit: boolean }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [d, setD] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [bad, setBad] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof ClinicDetails>(k: K, v: ClinicDetails[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    if (bad === k) setBad(null);
  };
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const zones = ZONES.includes(d.timezone) ? ZONES : [d.timezone, ...ZONES];
  const currencies = CURRENCIES.includes(d.currency) ? CURRENCIES : [d.currency, ...CURRENCIES];
  const off = !canEdit || pending;

  return (
    <Card>
      <CardHeader title={t.admin.tabDetails} sub={t.admin.slugFixed} />
      <form
        className="grid gap-4 px-5 pb-5"
        data-details-form
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await updateClinicDetailsAction(clinicId, d);
            if (r.error) {
              setBad(r.field ?? null);
              toast(t.common.genericError, "error");
              return;
            }
            setSaved(d);
            toast(t.admin.detailsSaved);
          });
        }}
      >
        <Field label={t.admin.slug}>
          <Input dir="ltr" value={`/${slug}`} disabled readOnly />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.admin.clinicName} required error={bad === "name" ? t.common.genericError : undefined}>
            <Input value={d.name} disabled={off} onChange={(e) => set("name", e.target.value)} data-detail="name" />
          </Field>
          <Field label={t.admin.clinicNameAr}>
            <Input dir="rtl" value={d.nameAr} disabled={off} onChange={(e) => set("nameAr", e.target.value)} />
          </Field>
          <Field label={t.common.phone} error={bad === "phone" ? t.common.genericError : undefined}>
            <Input dir="ltr" value={d.phone} disabled={off} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label={t.admin.mapsUrl}>
            <Input dir="ltr" value={d.mapsUrl} disabled={off} onChange={(e) => set("mapsUrl", e.target.value)} />
          </Field>
          <Field label={t.admin.address}>
            <Input value={d.address} disabled={off} onChange={(e) => set("address", e.target.value)} data-detail="address" />
          </Field>
          <Field label={t.admin.addressAr}>
            <Input dir="rtl" value={d.addressAr} disabled={off} onChange={(e) => set("addressAr", e.target.value)} />
          </Field>
          <Field label={t.admin.timezone} error={bad === "timezone" ? t.common.genericError : undefined}>
            <Select value={d.timezone} disabled={off} onChange={(e) => set("timezone", e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.admin.currency}>
            <Select value={d.currency} disabled={off} onChange={(e) => set("currency", e.target.value)}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.admin.language}>
            <Select value={d.defaultLocale} disabled={off} onChange={(e) => set("defaultLocale", e.target.value as "ar" | "en")}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label={t.admin.dailyCap} error={bad === "dailyCap" ? t.common.genericError : undefined}>
            <Input dir="ltr" type="number" min={10} max={5000} value={d.dailyCap} disabled={off} onChange={(e) => set("dailyCap", Number(e.target.value))} />
          </Field>
        </div>
        {canEdit && (
          <div className="flex justify-end">
            <Button type="submit" disabled={!dirty} loading={pending} data-save-details>
              {t.common.save}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
