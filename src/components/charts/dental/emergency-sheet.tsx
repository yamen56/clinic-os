"use client";

/*
  An emergency visit, in the middle of a plan or outside one.

  The dentist asked: when a patient in the middle of a root canal comes in
  with pain, do the planned sessions get cancelled? They do not. An emergency
  is a visit of its own, checked off: what brought them in and what was done,
  recorded against today. The plan stays as it was, and the sheet shows the
  next visit that stays, with a way to move it if the emergency changed the
  timing — the doctor's decision, never the software's.
*/

import { useState } from "react";
import { Siren } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { fmtDateTime } from "@/lib/dates";
import { EMERGENCY_ACTIONS, type EmergencyAction } from "@/lib/charts/dental/protocols";
import { isToothSite, type Mark } from "@/lib/charts/dental/state";
import type { Visit } from "@/lib/charts/dental/treatment";

export function EmergencySheet({
  item,
  site: initialSite,
  next,
  canBook,
  slug,
  tz,
  onRecord,
  onCancel,
}: {
  /** The treatment under way it interrupts, when it is one. */
  item: Mark | null;
  site: string | null;
  /** The visit that stays booked, if there is one. */
  next: Visit | null;
  canBook: boolean;
  slug: string;
  tz: string;
  onRecord: (e: { site: string; complaint: string; done: EmergencyAction[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const P = t.dental.treatment;
  const [site, setSite] = useState(initialSite && isToothSite(initialSite) ? initialSite : "");
  const [complaint, setComplaint] = useState("");
  const [done, setDone] = useState<EmergencyAction[]>(["pain"]);
  const [busy, setBusy] = useState(false);
  const validSite = site === "" || isToothSite(site);

  return (
    <div className="grid gap-4" data-emergency-sheet>
      <div className="flex items-start gap-3 rounded-card bg-danger-soft px-3 py-2.5">
        <Siren className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
        <div className="text-[13px] text-ink-900">
          {item ? (
            <>
              <span className="font-semibold">
                {isToothSite(item.site) ? `${item.site} · ` : ""}
                {locale === "ar" ? item.labelAr : item.label}
              </span>
              <span className="block text-ink-700">{P.emergencyPlan}</span>
            </>
          ) : (
            P.emergencyPlan
          )}
        </div>
      </div>

      {!item && (
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.emergencyTooth}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            value={site}
            onChange={(e) => setSite(e.target.value.replace(/\D/g, "").slice(0, 2))}
            placeholder={P.emergencyMouth}
            className={`h-10 w-32 rounded-ctl border bg-surface px-3 text-base tnum md:text-sm ${validSite ? "border-line" : "border-danger"}`}
            data-emergency-site
          />
        </label>
      )}

      <label className="block">
        <span className="mb-1 block text-[12px] font-semibold text-ink-500">{P.emergencyComplaint}</span>
        <input
          dir="auto"
          autoFocus
          value={complaint}
          onChange={(e) => setComplaint(e.target.value.slice(0, 300))}
          className="h-10 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm"
          data-emergency-complaint
        />
      </label>

      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-ink-500">{P.emergencyDone}</div>
        <div className="flex flex-wrap gap-1.5">
          {EMERGENCY_ACTIONS.map((k) => {
            const on = done.includes(k);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                data-emergency-action={k}
                onClick={() => setDone((d) => (on ? d.filter((x) => x !== k) : [...d, k]))}
                className={`h-9 rounded-full border px-3 text-[13px] font-semibold transition-colors duration-140 ${
                  on ? "border-danger bg-danger text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                }`}
              >
                {P.emergencyActions[k]}
              </button>
            );
          })}
        </div>
      </div>

      {/* The plan is not touched: the visit already booked stays, and can be moved by hand. */}
      {item && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-card bg-canvas px-3 py-2.5 text-[13px]" data-emergency-next={next?.id ?? ""}>
          <span className="text-ink-700">{next ? P.emergencyKeeps.replace("{when}", fmtDateTime(next.startsAt, tz, locale)) : P.emergencyNoVisit}</span>
          {next && canBook && (
            <a href={`/c/${slug}/calendar`} className={buttonClass({ variant: "outline", size: "sm" })}>
              {P.move}
            </a>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {t.dental.cancel}
        </Button>
        <Button
          variant="danger"
          loading={busy}
          disabled={!validSite || done.length === 0}
          data-record-emergency
          onClick={async () => {
            setBusy(true);
            await onRecord({ site: item ? item.site : site || "mouth", complaint: complaint.trim(), done });
            setBusy(false);
          }}
        >
          {P.record}
        </Button>
      </div>
    </div>
  );
}
