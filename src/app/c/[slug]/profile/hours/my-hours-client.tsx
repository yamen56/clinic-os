"use client";

import { useMemo, useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { WeeklyHoursEditor } from "@/components/weekly-hours-editor";
import { DAY_KEYS, effectiveHours, type WeeklyHours } from "@/lib/hours";
import { asLocale, when } from "@/lib/notification-text";
import { saveMyHoursAction, type HoursClash } from "../actions";

const rangesText = (ranges: [string, string][]) => ranges.map(([from, to]) => `${from}–${to}`).join(", ");

/**
 * Saved with a button, not autosaved. A half-typed time is not a decision, and
 * each save tells the desk, so a debounce would page reception mid-edit.
 */
export function MyHoursClient({
  slug,
  tz,
  clinicHours,
  initialHours,
}: {
  slug: string;
  tz: string;
  clinicHours: WeeklyHours;
  initialHours: WeeklyHours | null;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [saved, setSaved] = useState(initialHours);
  const [own, setOwn] = useState(!!initialHours);
  // Starts from what the clinic opens: the doctor trims it, not rebuilds it.
  const [hours, setHours] = useState<WeeklyHours>(initialHours ?? clinicHours);
  const [clashes, setClashes] = useState<{ total: number; list: HoursClash[] } | null>(null);
  const [pending, start] = useTransition();

  const value = own ? hours : null;
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  const days = t.hours.days as Record<string, string>;

  /* What the clinic takes back: a doctor can be open for less, never for more. */
  const limits = useMemo(() => {
    if (!own) return [];
    const bookable = effectiveHours(clinicHours, hours);
    return DAY_KEYS.filter((d) => rangesText(hours[d] ?? []) !== rangesText(bookable[d] ?? [])).map((d) =>
      (clinicHours[d] ?? []).length
        ? t.myHours.dayLimited.replace("{day}", days[d]).replace("{hours}", rangesText(clinicHours[d]))
        : t.myHours.dayClosed.replace("{day}", days[d])
    );
  }, [own, hours, clinicHours, days, t]);
  const noHours = own && DAY_KEYS.every((d) => !(hours[d] ?? []).length);

  const save = (confirmed: boolean) =>
    start(async () => {
      const r = await saveMyHoursAction(slug, value, { confirmed });
      if (r.error) {
        toast(r.error === "invalid" ? t.hours.invalid : t.common.genericError, "error");
        return;
      }
      if (r.clashes) {
        setClashes(r.clashes);
        return;
      }
      setClashes(null);
      setSaved(value);
      toast(t.myHours.saved);
    });

  return (
    <div className="grid grid-cols-1 gap-4">
      <Card className="p-5">
        <label className="mb-3 flex items-center gap-2.5">
          <Toggle checked={own} onChange={setOwn} />
          <span className="text-[13px] font-medium">{own ? t.staff.ownHours : t.staff.useClinicHours}</span>
        </label>

        {own && <WeeklyHoursEditor value={hours} onChange={setHours} />}

        {(limits.length > 0 || noHours) && (
          <ul data-hours-limits className="mt-3 grid gap-1 rounded-lg bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-ink-700">
            {noHours && <li>{t.myHours.noHours}</li>}
            {limits.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        <Button className="mt-4 min-h-10 w-full sm:w-auto" disabled={!dirty} loading={pending} onClick={() => save(false)}>
          {t.common.save}
        </Button>
      </Card>

      <Card className="p-5">
        <div className="mb-2 text-[13px] font-medium">{t.myHours.clinicOpen}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          {DAY_KEYS.map((d) => (
            <div key={d} className="contents">
              <dt className="text-ink-500">{days[d]}</dt>
              <dd className="tnum">{(clinicHours[d] ?? []).length ? rangesText(clinicHours[d]) : t.hours.closed}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <ConfirmDialog
        open={!!clashes}
        onClose={() => setClashes(null)}
        onConfirm={() => save(true)}
        title={t.myHours.clashTitle.replace("{n}", String(clashes?.total ?? 0))}
        body={t.myHours.clashBody}
        confirmLabel={t.myHours.saveAnyway}
        cancelLabel={t.common.cancel}
        danger={false}
        loading={pending}
      >
        <ul data-hours-clashes className="grid gap-1 text-[13px]">
          {clashes?.list.map((c) => (
            <li key={c.id} className="flex flex-wrap justify-between gap-x-3">
              <span className="tnum">{when(c.startsAt, tz, asLocale(locale))}</span>
              {c.patient && <span className="text-ink-500">{c.patient}</span>}
            </li>
          ))}
          {clashes && clashes.total > clashes.list.length && (
            <li className="text-ink-500">{t.myHours.clashMore.replace("{n}", String(clashes.total - clashes.list.length))}</li>
          )}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
