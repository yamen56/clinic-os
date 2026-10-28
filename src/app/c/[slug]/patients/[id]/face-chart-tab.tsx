"use client";

/*
  The face chart tab: aesthetic work on the patient's face, saved.

  Tap the parts of the face treated, pick what was done, say how much, save.
  Four taps for a routine Botox. Each saved treatment is drawn at once and
  stored behind it with an id the browser chose, so the dot and the row are
  the same entry from the start; if the server refuses, the dot goes and the
  chart says so. Saved work is on Ready to bill for reception, priced from the
  clinic's list.

  Tapping a part also shows everything done there before, with Repeat — what
  a doctor needs most at a Botox touch-up. Who may record is `patients.charts`;
  everybody else who can open the file reads the chart and its history.
*/

import { useMemo, useState } from "react";
import Link from "next/link";
import { Repeat2, Undo2, X } from "lucide-react";
import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { ConfirmDialog } from "@/components/ui/modal";
import { Input, Select, Textarea } from "@/components/ui/input";
import { fmtDate, fmtMoney } from "@/lib/dates";
import {
  DEFAULT_UNITS,
  FACE_TREATMENTS,
  FACE_TREATMENT_BY_KEY,
  FAMILY_COLOR,
  FAMILIES,
  PRESETS,
  ZONE_BY_KEY,
  amountText,
  feeOf,
  inFaceOrder,
  quantityOf,
  totalUnits,
  unitsText,
  whereText,
  type Area,
  type Family,
  type FaceTreatment,
} from "@/lib/charts/face/catalog";
import type { FaceMark } from "@/lib/charts/face/db";
import type { MarkEvent } from "@/lib/charts/dental/state";
import { call, newId, useFaceStore } from "@/components/charts/face/store";
import { FaceMap } from "@/components/charts/face/face-map";
import { FaceReadyToBill } from "@/components/charts/face/ready-to-bill";

/** How long a toxin lasts, near enough to say when the patient is due again. */
const TOXIN_DAYS = 120;
/** A mis-tap can be taken back for this long, by the one who made it (the route agrees). */
const UNDO_MS = 2 * 60_000;

export function FaceChartTab({ tz }: { tz: string }) {
  const { t } = useI18n();
  return (
    <I18nProvider dict={t} locale="en">
      <div dir="ltr" lang="en" className="font-sans" data-latin-island data-face-chart>
        <FaceChart tz={tz} />
      </div>
    </I18nProvider>
  );
}

function FaceChart({ tz }: { tz: string }) {
  const s = useFaceStore();
  const { t, locale } = useI18n();
  const F = t.face;
  const { toast } = useToast();
  const base = `/api/c/${s.slug}/patients/${s.patientId}/face/marks`;

  const [sel, setSel] = useState<string[]>([]);
  const [tKey, setTKey] = useState<string | null>(null);
  const [units, setUnits] = useState<Record<string, number>>({});
  const [count, setCount] = useState(1);
  const [doer, setDoer] = useState<string>(() => (s.myMemberId && s.doctors.some((d) => d.id === s.myMemberId) ? s.myMemberId : ""));
  const [note, setNote] = useState("");
  const [showAreas, setShowAreas] = useState(true);
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<FaceMark | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [pricing, setPricing] = useState<{ id: string; value: string } | null>(null);
  const [now] = useState(() => Date.now());

  const tr = tKey ? (FACE_TREATMENT_BY_KEY.get(tKey) ?? null) : null;
  const live = useMemo(() => s.marks.filter((m) => !m.voidedAt), [s.marks]);
  const newestFirst = useMemo(() => [...s.marks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [s.marks]);
  const billedIds = useMemo(() => new Set(s.billing.filter((b) => b.qty > 0).map((b) => b.markId)), [s.billing]);

  // The kinds of work on each part of the face, for its dots.
  const dots = useMemo(() => {
    const m = new Map<string, Family[]>();
    for (const x of live) {
      for (const a of x.areas) {
        const list = m.get(a.zone) ?? [];
        if (!list.includes(x.family)) list.push(x.family);
        m.set(a.zone, list);
      }
    }
    return m;
  }, [live]);

  // The latest toxin, and when it wears off.
  const dueAgain = useMemo(() => {
    const last = live.filter((m) => m.family === "toxin" && m.doneAt).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!))[0];
    if (!last) return null;
    const at = new Date(new Date(last.doneAt!).getTime() + TOXIN_DAYS * 86_400_000);
    return { id: last.id, text: F.dueAgain.replace("{date}", fmtDate(at, tz, locale)) };
  }, [live, F.dueAgain, tz, locale]);

  const priceOf = (key: string) => s.prices.find((p) => p.chartKey === key) ?? null;
  const money = (n: number) => fmtMoney(n, s.currency, locale);
  const nameOf = (m: FaceMark) => m.label;

  /* ---- choosing ---- */

  const unitsFor = (zone: string, from?: Area[]) => from?.find((a) => a.zone === zone)?.units ?? DEFAULT_UNITS[zone] ?? 10;

  const toggleZone = (zone: string) => {
    const on = sel.includes(zone);
    if (tr && !on && !tr.fits.includes(zone)) {
      toast(F.notDoneOn.replace("{treatment}", tr.en).replace("{area}", ZONE_BY_KEY.get(zone)?.en ?? zone), "error");
      return;
    }
    const next = on ? sel.filter((z) => z !== zone) : [...sel, zone];
    setSel(next);
    if (tr?.units && !on) setUnits((u) => ({ ...u, [zone]: unitsFor(zone) }));
    if (!next.length) setTKey(null);
  };

  const preset = (zones: string[]) => {
    const fit = tr ? zones.filter((z) => tr.fits.includes(z)) : zones;
    setSel(fit);
    if (tr?.units) setUnits(Object.fromEntries(fit.map((z) => [z, unitsFor(z)])));
    if (!fit.length) setTKey(null);
  };

  const clear = () => {
    setSel([]);
    setTKey(null);
  };

  const start = (k: string, from?: FaceMark) => {
    const t2 = FACE_TREATMENT_BY_KEY.get(k);
    if (!t2) return;
    const zones = from ? from.areas.map((a) => a.zone) : sel;
    setSel(zones);
    setTKey(k);
    setUnits(t2.units ? Object.fromEntries(zones.map((z) => [z, unitsFor(z, from?.areas)])) : {});
    setCount(from && from.quantity && (t2.pricedBy === "syringe" || t2.pricedBy === "thread") ? from.quantity : t2.pricedBy === "thread" ? 4 : 1);
    if (from?.performedBy && s.doctors.some((d) => d.id === from.performedBy!.id)) setDoer(from.performedBy.id);
    setNote("");
  };

  const fits = useMemo(() => (sel.length ? FACE_TREATMENTS.filter((x) => sel.every((z) => x.fits.includes(z))) : []), [sel]);
  const here = useMemo(() => newestFirst.filter((m) => !m.voidedAt && m.areas.some((a) => sel.includes(a.zone))), [newestFirst, sel]);

  /* ---- writing ---- */

  const areasNow = (x: FaceTreatment): Area[] => inFaceOrder(sel.map((z) => (x.units ? { zone: z, units: units[z] ?? 0 } : { zone: z })));

  const save = () => {
    if (!tr || !sel.length) return;
    const areas = areasNow(tr);
    const quantity = quantityOf(tr, areas, count);
    const price = priceOf(tr.key);
    const id = newId();
    const eventId = newId();
    const performer = s.doctors.find((d) => d.id === doer) ?? null;
    const at = new Date().toISOString();
    const fresh: FaceMark = {
      id,
      treatmentKey: tr.key,
      label: tr.en,
      labelAr: tr.ar,
      family: tr.family,
      areas,
      quantity,
      fee: feeOf(price?.price ?? null, quantity),
      feeManual: false,
      serviceId: price?.serviceId ?? null,
      note: note.trim(),
      performedBy: performer,
      recordedBy: s.me,
      createdAt: at,
      doneAt: at,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      appointmentId: null,
    };
    s.setMarks((prev) => [...prev, fresh]);
    clear();
    setNote("");
    toast(s.canBill ? F.saved : F.savedOnly);
    s.write(
      [id],
      call<{ mark: FaceMark; events: MarkEvent[] }>(base, "POST", {
        id,
        eventId,
        treatmentKey: tr.key,
        areas,
        count,
        performedBy: performer?.id ?? null,
        note: fresh.note,
      })
    )
      .then((r) => {
        s.setMarks((prev) => prev.map((m) => (m.id === id ? r.mark : m)));
        s.setEvents((prev) => [...prev.filter((e) => e.markId !== id), ...r.events]);
      })
      .catch(() => {
        s.setMarks((prev) => prev.filter((m) => m.id !== id));
        toast(F.saveFailed, "error");
      });
  };

  const undo = (m: FaceMark) => {
    s.setMarks((prev) => prev.filter((x) => x.id !== m.id));
    s.write([m.id], call(`${base}/${m.id}`, "DELETE")).then(
      () => toast(F.undone),
      () => {
        s.setMarks((prev) => [...prev, m]);
        toast(F.saveFailed, "error");
      }
    );
  };

  const patch = (m: FaceMark, body: Record<string, unknown>, optimistic: Partial<FaceMark>, failed = F.saveFailed) => {
    const eventId = newId();
    s.setMarks((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...optimistic } : x)));
    s.write([m.id], call<{ mark: FaceMark; event: MarkEvent }>(`${base}/${m.id}`, "PATCH", { ...body, eventId }))
      .then((r) => {
        s.setMarks((prev) => prev.map((x) => (x.id === m.id ? r.mark : x)));
        s.setEvents((prev) => [...prev, r.event]);
      })
      .catch((e: Error) => {
        s.setMarks((prev) => prev.map((x) => (x.id === m.id ? m : x)));
        toast(e.message === "billed" ? F.priceLocked : failed, "error");
      });
  };

  const voidIt = () => {
    if (!voiding) return;
    patch(voiding, { op: "void", reason: voidReason.trim() || undefined }, { voidedAt: new Date().toISOString(), voidedBy: s.me, voidReason: voidReason.trim() || null });
    setVoiding(null);
    setVoidReason("");
  };

  const setPrice = (m: FaceMark, value: string | null) => {
    const fee = value === null ? null : Number(value);
    if (fee !== null && (!Number.isFinite(fee) || fee < 0)) return;
    const list = feeOf(priceOf(m.treatmentKey)?.price ?? null, m.quantity ?? 1);
    patch(m, { op: "fee", fee }, { fee: fee ?? list, feeManual: fee !== null }, F.priceFailed);
    setPricing(null);
  };

  /* ---- reading ---- */

  const amountOf = (m: FaceMark) => {
    const x = FACE_TREATMENT_BY_KEY.get(m.treatmentKey);
    const parts: string[] = [];
    if (x && x.pricedBy !== "session" && m.quantity != null) parts.push(amountText(x.pricedBy, m.quantity, "en"));
    const u = x ? totalUnits(x, m.areas) : null;
    if (u) parts.push(unitsText(u, "en"));
    return parts.join(" · ");
  };

  // A plain function, not a component: a component made here would be a new type each render, and remount — the price box would lose its cursor on every key.
  const row = (m: FaceMark, compact?: boolean) => {
    const mine = m.recordedBy.id === s.me.id && now - new Date(m.createdAt).getTime() < UNDO_MS;
    const billed = billedIds.has(m.id);
    const meta = [fmtDate(m.doneAt ?? m.createdAt, tz, locale), amountOf(m), m.performedBy ? F.by.replace("{name}", m.performedBy.name) : null].filter(Boolean).join(" · ");
    return (
      <li key={m.id} className={`flex items-start gap-2.5 py-2.5 ${m.voidedAt ? "opacity-60" : ""}`} data-face-entry={m.id} data-voided={m.voidedAt ? "" : undefined}>
        <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: FAMILY_COLOR[m.family] }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 text-[13.5px] font-semibold">
            <span className={m.voidedAt ? "line-through" : ""}>{nameOf(m)}</span>
            {m.voidedAt && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{F.voided}</span>}
            {billed && !m.voidedAt && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{F.billed}</span>}
          </div>
          <div className="text-[13px] text-ink-700">{whereText(m.areas.map((a) => a.zone), "en")}</div>
          <div className="text-[12px] text-ink-500 tnum">{meta}</div>
          {m.note && !compact && <div className="mt-0.5 whitespace-pre-line text-[12.5px] text-ink-700">{m.note}</div>}
          {m.voidedAt && m.voidReason && !compact && <div className="text-[12px] text-ink-500">{m.voidReason}</div>}
          {!m.voidedAt && dueAgain?.id === m.id && (
            <span className="mt-1 inline-block rounded-full bg-brand-50 px-2.5 py-0.5 text-[12px] font-semibold text-brand-700" data-due-again>
              {dueAgain.text}
            </span>
          )}
          {/* This patient's price, set by hand — before it is billed. */}
          {pricing?.id === m.id && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="w-32 shrink-0">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={pricing.value}
                  onChange={(e) => setPricing({ id: m.id, value: e.target.value })}
                  className="h-9"
                  aria-label={F.editPrice}
                  autoFocus
                />
              </div>
              <Button size="sm" onClick={() => setPrice(m, pricing.value)} disabled={pricing.value === ""}>
                {F.save}
              </Button>
              {m.feeManual && (
                <Button size="sm" variant="outline" onClick={() => setPrice(m, null)}>
                  {F.useListPrice}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setPricing(null)}>
                {F.cancel}
              </Button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {!compact && <span className="text-[13px] font-semibold tnum">{m.fee != null ? money(m.fee) : "—"}</span>}
          {!m.voidedAt && (
            <div className="flex flex-wrap justify-end gap-1">
              {s.canWrite && FACE_TREATMENT_BY_KEY.has(m.treatmentKey) && (
                <button
                  type="button"
                  onClick={() => start(m.treatmentKey, m)}
                  className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-brand-700 hover:bg-sunken"
                  aria-label={F.repeatOf.replace("{treatment}", m.label)}
                  data-face-repeat={m.id}
                >
                  <Repeat2 className="h-3.5 w-3.5" />
                  {F.repeat}
                </button>
              )}
              {!compact && mine && s.canWrite && !billed && (
                <button type="button" onClick={() => undo(m)} className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-ink-500 hover:bg-sunken" data-face-undo={m.id}>
                  <Undo2 className="h-3.5 w-3.5" />
                  {F.undo}
                </button>
              )}
              {!compact && (s.canWrite || s.canBill) && !billed && pricing?.id !== m.id && (
                <button
                  type="button"
                  onClick={() => setPricing({ id: m.id, value: m.fee != null ? String(m.fee) : "" })}
                  className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-semibold text-ink-500 hover:bg-sunken"
                  data-face-price={m.id}
                >
                  {F.editPrice}
                </button>
              )}
              {!compact && s.canWrite && !mine && (
                <button
                  type="button"
                  onClick={() => setVoiding(m)}
                  className="inline-flex h-7 items-center rounded-full px-2.5 text-[12px] font-semibold text-ink-500 hover:bg-danger-soft hover:text-danger"
                  data-face-void={m.id}
                >
                  {F.voidAction}
                </button>
              )}
            </div>
          )}
        </div>
      </li>
    );
  };

  const recent = newestFirst.filter((m) => !m.voidedAt).slice(0, 5);
  const voidedCount = s.marks.filter((m) => m.voidedAt).length;
  const shown = showVoided ? newestFirst : newestFirst.filter((m) => !m.voidedAt);

  /* ---- the record panel's numbers ---- */
  const areasPreview = tr ? areasNow(tr) : [];
  const quantity = tr ? quantityOf(tr, areasPreview, count) : 0;
  const listPrice = tr ? priceOf(tr.key) : null;
  const fee = tr ? feeOf(listPrice?.price ?? null, quantity) : null;
  const unitsTotal = tr ? totalUnits(tr, areasPreview) : null;

  const stepper = (label: string, value: number, set: (n: number) => void, min = 1) => (
    <div className="flex items-center gap-2.5">
      <span className="flex-1 text-[13.5px] font-semibold">{label}</span>
      <button
        type="button"
        onClick={() => set(Math.max(min, value - 1))}
        aria-label={F.less}
        className="h-9 w-9 shrink-0 rounded-ctl border border-line-strong text-[17px] hover:bg-sunken"
      >
        −
      </button>
      <span className="w-10 text-center text-[15px] font-bold tnum">{value}</span>
      <button type="button" onClick={() => set(value + 1)} aria-label={F.oneMore} className="h-9 w-9 shrink-0 rounded-ctl border border-line-strong text-[17px] hover:bg-sunken">
        +
      </button>
    </div>
  );

  return (
    <div className="grid gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* The face */}
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-ink-500">{F.quickSelect}</span>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => preset(p.zones)}
                className="inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[12.5px] font-medium hover:bg-sunken"
                data-face-preset={p.key}
              >
                {p.en}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={showAreas}
              onClick={() => setShowAreas((v) => !v)}
              className={`ms-auto inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[12.5px] font-medium ${showAreas ? "bg-sunken" : "hover:bg-sunken"}`}
            >
              {F.showAreas}
            </button>
          </div>
          <FaceMap selected={sel} dots={dots} showAreas={showAreas} onToggle={toggleZone} labels={{ right: F.patientRight, left: F.patientLeft }} />
          <div className="mt-3 flex flex-wrap justify-center gap-x-3.5 gap-y-1 border-t border-line pt-3">
            {FAMILIES.map((f) => (
              <span key={f} className="inline-flex items-center gap-1.5 text-[12px] text-ink-700">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_COLOR[f] }} aria-hidden />
                {F.families[f]}
              </span>
            ))}
          </div>
        </Card>

        {/* What was done */}
        <Card className="p-4" >
          {!sel.length && (
            <div data-face-panel="idle">
              <h3 className="text-[16px] font-semibold">{F.addTitle}</h3>
              <p className="mt-0.5 text-[13px] text-ink-500">{s.canWrite ? F.addHint : F.readOnly}</p>
              <h4 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-500">{F.recent}</h4>
              {recent.length ? (
                <ul className="divide-y divide-line">
                  {recent.map((m) => (
                    row(m, true)
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[13px] text-ink-500">{F.nothingYet}</p>
              )}
            </div>
          )}

          {sel.length > 0 && !tr && (
            <div data-face-panel="areas">
              <div className="flex items-center gap-2">
                <h3 className="text-[16px] font-semibold">{sel.length === 1 ? ZONE_BY_KEY.get(sel[0])?.en : F.areas.replace("{n}", String(sel.length))}</h3>
                <Button size="sm" variant="outline" className="ms-auto" onClick={clear}>
                  {F.clear}
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {inFaceOrder(sel.map((zone) => ({ zone }))).map(({ zone }) => (
                  <button
                    key={zone}
                    type="button"
                    onClick={() => toggleZone(zone)}
                    aria-label={F.remove.replace("{area}", ZONE_BY_KEY.get(zone)?.en ?? zone)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-brand-600 bg-sunken ps-3 pe-2 text-[12.5px] font-semibold"
                  >
                    {ZONE_BY_KEY.get(zone)?.en}
                    <X className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>

              <h4 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-500">{F.doneHere}</h4>
              {here.length ? (
                <ul className="divide-y divide-line">
                  {here.map((m) => (
                    row(m, true)
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[13px] text-ink-500">{F.nothingHere}</p>
              )}

              {s.canWrite && (
                <>
                  <h4 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-500">{F.whatDone}</h4>
                  {fits.length ? (
                    <div className="mt-2 grid grid-cols-2 gap-2" data-face-fits={fits.length}>
                      {fits.map((x) => {
                        const p = priceOf(x.key);
                        return (
                          <button
                            key={x.key}
                            type="button"
                            onClick={() => start(x.key)}
                            className="flex min-h-14 flex-col items-start justify-center gap-0.5 rounded-ctl border border-line-strong px-3 py-2 text-start hover:bg-sunken"
                            data-face-treatment={x.key}
                          >
                            <span className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_COLOR[x.family] }} aria-hidden />
                              {x.en}
                            </span>
                            <span className="text-[12px] text-ink-500 tnum">{p ? `${money(p.price)} ${F.pricedBy[x.pricedBy]}` : F.noPrice}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-1 text-[13px] text-ink-500">{F.noneFits}</p>
                  )}
                </>
              )}
            </div>
          )}

          {tr && sel.length > 0 && (
            <div className="grid gap-3.5" data-face-panel="record">
              <div className="flex items-start gap-2">
                <div className="min-w-0">
                  <h3 className="inline-flex items-center gap-2 text-[16px] font-semibold">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: FAMILY_COLOR[tr.family] }} aria-hidden />
                    {tr.en}
                  </h3>
                  <div className="text-[13px] text-ink-700">{whereText(sel, "en")}</div>
                </div>
                <Button size="sm" variant="outline" className="ms-auto shrink-0" onClick={() => setTKey(null)}>
                  {F.change}
                </Button>
              </div>

              {tr.units && (
                <div>
                  <h4 className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">{F.unitsPerArea}</h4>
                  <div className="mt-1.5 grid gap-1.5">
                    {areasPreview.map((a) => {
                      const name = ZONE_BY_KEY.get(a.zone)?.en ?? a.zone;
                      return (
                        <div key={a.zone} className="flex items-center gap-2.5" data-face-units={a.zone}>
                          <span className="min-w-0 flex-1 text-[13.5px]">{name}</span>
                          <button
                            type="button"
                            onClick={() => setUnits((u) => ({ ...u, [a.zone]: Math.max(0, (u[a.zone] ?? 0) - 2) }))}
                            aria-label={F.fewer.replace("{area}", name)}
                            className="h-9 w-9 shrink-0 rounded-ctl border border-line-strong text-[17px] hover:bg-sunken"
                          >
                            −
                          </button>
                          {/* A plain box, not the kit's Input: that one takes the whole row. */}
                          <input
                            type="text"
                            inputMode="numeric"
                            value={String(a.units ?? 0)}
                            onChange={(e) => /^\d{0,4}$/.test(e.target.value) && setUnits((u) => ({ ...u, [a.zone]: Math.min(1000, Number(e.target.value) || 0) }))}
                            className="h-9 w-14 shrink-0 rounded-ctl border border-line-strong bg-surface text-center text-base font-semibold tnum focus:border-brand-600 focus:outline-none md:text-sm"
                            aria-label={name}
                          />
                          <button
                            type="button"
                            onClick={() => setUnits((u) => ({ ...u, [a.zone]: Math.min(1000, (u[a.zone] ?? 0) + 2) }))}
                            aria-label={F.more.replace("{area}", name)}
                            className="h-9 w-9 shrink-0 rounded-ctl border border-line-strong text-[17px] hover:bg-sunken"
                          >
                            +
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-1 text-end text-[13px] font-bold tnum">{F.unitsTotal.replace("{n}", String(unitsTotal ?? 0))}</div>
                </div>
              )}

              {tr.pricedBy === "syringe" && stepper(F.count.syringe, count, setCount)}
              {tr.pricedBy === "thread" && stepper(F.count.thread, count, setCount)}

              <label className="grid gap-1 text-[12.5px] font-semibold text-ink-500">
                {F.doneBy}
                <Select value={doer} onChange={(e) => setDoer(e.target.value)} data-face-doer>
                  <option value="">{F.noDoctor}</option>
                  {s.doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="grid gap-1 text-[12.5px] font-semibold text-ink-500">
                {F.note}
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={F.notePlaceholder} maxLength={2000} className="min-h-16" />
              </label>

              <div className="flex items-baseline gap-2 rounded-ctl bg-sunken px-3.5 py-3">
                <span className="flex-1">
                  <span className="text-[13.5px] font-semibold">{F.price}</span>
                  <span className="block text-[12px] text-ink-500 tnum">
                    {listPrice ? `${amountText(tr.pricedBy, quantity, "en")} × ${money(listPrice.price)}` : F.noPrice}
                  </span>
                </span>
                {fee != null ? (
                  <span className="text-[16px] font-bold tnum" data-face-fee={fee}>
                    {money(fee)}
                  </span>
                ) : (
                  s.canPrice && (
                    <Link href={`/c/${s.slug}/settings/face-prices`} className="text-[12.5px] font-semibold text-brand-700 hover:underline">
                      {F.setPrices}
                    </Link>
                  )
                )}
              </div>

              <div className="flex gap-2">
                <Button className="flex-1" onClick={save} data-face-save disabled={!!tr.units && (unitsTotal ?? 0) <= 0}>
                  {F.save}
                </Button>
                <Button variant="outline" onClick={clear}>
                  {F.cancel}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* For whoever bills: the work done and not on an invoice yet, billed from here. */}
      <FaceReadyToBill className="p-4" />

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold">{F.history}</h3>
          {voidedCount > 0 && (
            <button type="button" onClick={() => setShowVoided((v) => !v)} className="ms-auto text-[12.5px] font-semibold text-brand-700 hover:underline">
              {showVoided ? F.hideVoided : F.showVoided.replace("{n}", String(voidedCount))}
            </button>
          )}
        </div>
        {shown.length ? (
          <ul className="mt-1 divide-y divide-line" data-face-history={shown.length}>
            {shown.map((m) => (
              row(m)
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-ink-500">{F.nothingYet}</p>
        )}
      </Card>

      <ConfirmDialog
        open={!!voiding}
        onClose={() => setVoiding(null)}
        onConfirm={voidIt}
        title={F.voidTitle}
        body={F.voidBody}
        confirmLabel={F.voidAction}
        cancelLabel={F.cancel}
      >
        <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={F.voidReason} maxLength={300} aria-label={F.voidReason} />
      </ConfirmDialog>
    </div>
  );
}
