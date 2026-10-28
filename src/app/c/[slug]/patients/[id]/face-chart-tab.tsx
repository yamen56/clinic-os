"use client";

/*
  The face chart tab: aesthetic work on the patient's face, saved.

  Tap the parts of the face treated, pick what was done, say how much and with
  which product, save. Four taps for a routine Botox. Each saved treatment is
  drawn at once and stored behind it with an id the browser chose, so the
  tinted area and the row are the same entry from the start; if the server
  refuses, the tint goes and the chart says so. Saved work is on Ready to bill
  for reception, priced from the clinic's list — or covered by one of the
  patient's packages, with no new charge.

  Tapping a part also shows everything done there before, with Repeat — what
  a doctor needs most at a Botox touch-up. Every note written here, and every
  note edited later, is in the patient's Notes too (notes-feed.tsx).

  Who may record is `patients.charts`; everybody else who can open the file
  reads the chart and its history. Colour says what kind of work it was —
  tinted areas and labels, never dots (Yamen, 2026-10-28).
*/

import { useMemo, useState } from "react";
import Link from "next/link";
import { PackagePlus, Repeat2, Undo2, X } from "lucide-react";
import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Input, Select, Textarea } from "@/components/ui/input";
import { fmtDate, fmtDateOnly, fmtMoney } from "@/lib/dates";
import {
  DEFAULT_UNITS,
  FACE_TREATMENTS,
  FACE_TREATMENT_BY_KEY,
  FAMILIES,
  FAMILY_COLOR,
  PRESETS,
  ZONE_BY_KEY,
  amountText,
  feeOf,
  inFaceOrder,
  pickFacePrice,
  productAmount,
  quantityOf,
  totalUnits,
  unitsText,
  whereText,
  type Area,
  type Family,
  type FaceTreatment,
} from "@/lib/charts/face/catalog";
import type { FaceMark } from "@/lib/charts/face/db";
import type { StockProduct } from "@/lib/charts/face/stock";
import { PACKAGE_KEY, type PatientPackage } from "@/lib/charts/face/packages";
import type { MarkEvent } from "@/lib/charts/dental/state";
import { call, newId, useFaceStore } from "@/components/charts/face/store";
import { FaceMap } from "@/components/charts/face/face-map";
import { FaceReadyToBill } from "@/components/charts/face/ready-to-bill";
import { FamilyTag } from "@/components/charts/face/family-tag";

/** How long a toxin lasts, near enough to say when the patient is due again. */
const TOXIN_DAYS = 120;
/** A mis-tap can be taken back for this long, by the one who made it (the route agrees). */
const UNDO_MS = 2 * 60_000;

export function FaceChartTab({ tz, today }: { tz: string; today: string }) {
  const { t } = useI18n();
  return (
    <I18nProvider dict={t} locale="en">
      <div dir="ltr" lang="en" className="font-sans" data-latin-island data-face-chart>
        <FaceChart tz={tz} today={today} />
      </div>
    </I18nProvider>
  );
}

/** What a product would cost for so much, taken as the chart takes it: the batch that expires first, then the next. */
function costPreview(p: StockProduct, qty: number): { cost: number; short: boolean } {
  let left = qty;
  let cost = 0;
  for (const b of p.batches) {
    if (left <= 0) break;
    if (b.onHand <= 0) continue;
    const take = Math.min(left, b.onHand);
    cost += take * b.unitCost;
    left -= take;
  }
  if (left > 0) cost += left * (p.lastCost ?? 0);
  return { cost: Math.round(cost * 100) / 100, short: left > 0 };
}

/** A package a session may come from: not voided, not run out, with a session of this treatment left. */
function usableItem(pkgs: PatientPackage[], key: string, today: string) {
  for (const p of pkgs) {
    if (p.voided || (p.expiresOn && p.expiresOn < today)) continue;
    const item = p.items.find((i) => i.treatmentKey === key && i.used < i.sessions);
    if (item) return { pkg: p, item };
  }
  return null;
}

function FaceChart({ tz, today }: { tz: string; today: string }) {
  const s = useFaceStore();
  const { t, locale } = useI18n();
  const F = t.face;
  const { toast } = useToast();
  const base = `/api/c/${s.slug}/patients/${s.patientId}/face`;

  const [sel, setSel] = useState<string[]>([]);
  const [tKey, setTKey] = useState<string | null>(null);
  const [units, setUnits] = useState<Record<string, number>>({});
  const [count, setCount] = useState(1);
  const [doer, setDoer] = useState<string>(() => (s.myMemberId && s.doctors.some((d) => d.id === s.myMemberId) ? s.myMemberId : ""));
  const [note, setNote] = useState("");
  const [productId, setProductId] = useState<string>("");
  const [qtyText, setQtyText] = useState<string | null>(null);
  const [fromPackage, setFromPackage] = useState(true);
  const [showAreas, setShowAreas] = useState(true);
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<FaceMark | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [pricing, setPricing] = useState<{ id: string; value: string } | null>(null);
  const [noting, setNoting] = useState<{ id: string; value: string } | null>(null);
  const [selling, setSelling] = useState(false);
  const [now] = useState(() => Date.now());

  const tr = tKey ? (FACE_TREATMENT_BY_KEY.get(tKey) ?? null) : null;
  // The package sales are entries too, but nothing is done on the face by selling one.
  const work = useMemo(() => s.marks.filter((m) => m.treatmentKey !== PACKAGE_KEY), [s.marks]);
  const live = useMemo(() => work.filter((m) => !m.voidedAt), [work]);
  const newestFirst = useMemo(() => [...s.marks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [s.marks]);
  const billedIds = useMemo(() => new Set(s.billing.filter((b) => b.qty > 0).map((b) => b.markId)), [s.billing]);
  const itemOf = useMemo(() => {
    const m = new Map<string, { pkg: PatientPackage; n: number; total: number }>();
    for (const p of s.packages) {
      for (const i of p.items) {
        // Which session each was, in the order they were done.
        const done = live.filter((x) => x.packageItemId === i.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        done.forEach((x, n) => m.set(x.id, { pkg: p, n: n + 1, total: i.sessions }));
      }
    }
    return m;
  }, [s.packages, live]);

  // The kind of work last done on each part of the face, for its tint.
  const tints = useMemo(() => {
    const m = new Map<string, Family>();
    for (const x of [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) for (const a of x.areas) m.set(a.zone, x.family);
    return m;
  }, [live]);

  // The latest toxin, and when it wears off.
  const dueAgain = useMemo(() => {
    const last = live.filter((m) => m.family === "toxin" && m.doneAt).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!))[0];
    if (!last) return null;
    const at = new Date(new Date(last.doneAt!).getTime() + TOXIN_DAYS * 86_400_000);
    return { id: last.id, text: F.dueAgain.replace("{date}", fmtDate(at, tz, locale)) };
  }, [live, F.dueAgain, tz, locale]);

  const money = (n: number) => fmtMoney(n, s.currency, locale);
  const productsFor = (key: string) => s.products.filter((p) => p.treatments.includes(key));
  const usedOn = (markId: string) => s.markProducts.filter((u) => u.markId === markId);

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
    // The product it was done with last time, else the first with some on hand.
    const own = productsFor(k);
    const before = from ? usedOn(from.id)[0] : undefined;
    const pick = (before && own.find((p) => p.id === before.productId)) ?? own.find((p) => p.onHand > 0) ?? own[0];
    setProductId(pick?.id ?? "");
    setQtyText(before && pick?.id === before.productId && pick.unit !== "u" ? String(before.qty) : null);
    setFromPackage(true);
    setNote("");
  };

  const fits = useMemo(() => (sel.length ? FACE_TREATMENTS.filter((x) => sel.every((z) => x.fits.includes(z))) : []), [sel]);
  const here = useMemo(() => newestFirst.filter((m) => !m.voidedAt && m.areas.some((a) => sel.includes(a.zone))), [newestFirst, sel]);

  /* ---- the record panel's numbers ---- */

  const areasNow = (x: FaceTreatment): Area[] => inFaceOrder(sel.map((z) => (x.units ? { zone: z, units: units[z] ?? 0 } : { zone: z })));
  const areasPreview = tr ? areasNow(tr) : [];
  const quantity = tr ? quantityOf(tr, areasPreview, count) : 0;
  const unitsTotal = tr ? totalUnits(tr, areasPreview) : null;
  const product = tr && productId ? (s.products.find((p) => p.id === productId && p.treatments.includes(tr.key)) ?? null) : null;
  const defaultQty = !product ? 0 : product.unit === "u" ? (unitsTotal ?? 0) : product.unit === tr?.pricedBy ? count : 1;
  const qty = product ? (qtyText === null ? defaultQty : Number(qtyText) || 0) : 0;
  const preview = product && qty > 0 ? costPreview(product, qty) : null;
  const covering = tr ? usableItem(s.packages, tr.key, today) : null;
  const covered = !!covering && fromPackage;
  const listPrice = tr ? pickFacePrice(s.prices, tr.key, product?.id ?? null) : null;
  const fee = tr ? (covered ? 0 : feeOf(listPrice?.price ?? null, quantity)) : null;
  const worth = covering ? (covering.item.value / covering.item.sessions) : null;

  /* ---- writing ---- */

  const save = () => {
    if (!tr || !sel.length) return;
    const areas = areasNow(tr);
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
      fee,
      feeManual: false,
      serviceId: listPrice?.serviceId ?? null,
      note: note.trim(),
      performedBy: performer,
      recordedBy: s.me,
      createdAt: at,
      doneAt: at,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      appointmentId: null,
      packageItemId: covered ? covering!.item.id : null,
    };
    s.setMarks((prev) => [...prev, fresh]);
    clear();
    setNote("");
    toast(s.canBill && !covered ? F.saved : F.savedOnly);
    s.write(
      [id],
      call<{ mark: FaceMark; events: MarkEvent[] }>(`${base}/marks`, "POST", {
        id,
        eventId,
        treatmentKey: tr.key,
        areas,
        count,
        performedBy: performer?.id ?? null,
        note: fresh.note,
        product: product && qty > 0 ? { id: product.id, qty } : null,
        packageItemId: fresh.packageItemId,
      })
    )
      .then((r) => {
        s.setMarks((prev) => prev.map((m) => (m.id === id ? r.mark : m)));
        s.setEvents((prev) => [...prev.filter((e) => e.markId !== id), ...r.events]);
        // What is on hand, what it used, the package's sessions: the server's word.
        if (product || fresh.packageItemId) void s.reload();
      })
      .catch(() => {
        s.setMarks((prev) => prev.filter((m) => m.id !== id));
        toast(F.saveFailed, "error");
      });
  };

  const undo = (m: FaceMark) => {
    s.setMarks((prev) => prev.filter((x) => x.id !== m.id));
    s.write([m.id], call(`${base}/marks/${m.id}`, "DELETE")).then(
      () => {
        toast(F.undone);
        void s.reload();
      },
      () => {
        s.setMarks((prev) => [...prev, m]);
        toast(F.saveFailed, "error");
      }
    );
  };

  const patch = (m: FaceMark, body: Record<string, unknown>, optimistic: Partial<FaceMark>, opts: { failed?: string; done?: string; reload?: boolean } = {}) => {
    const eventId = newId();
    s.setMarks((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...optimistic } : x)));
    s.write([m.id], call<{ mark: FaceMark; event: MarkEvent }>(`${base}/marks/${m.id}`, "PATCH", { ...body, eventId }))
      .then((r) => {
        s.setMarks((prev) => prev.map((x) => (x.id === m.id ? r.mark : x)));
        s.setEvents((prev) => [...prev, r.event]);
        if (opts.done) toast(opts.done);
        if (opts.reload) void s.reload();
      })
      .catch((e: Error) => {
        s.setMarks((prev) => prev.map((x) => (x.id === m.id ? m : x)));
        toast(e.message === "billed" ? F.priceLocked : e.message === "package_used" ? F.packageInUse : (opts.failed ?? F.saveFailed), "error");
      });
  };

  const voidIt = () => {
    if (!voiding) return;
    patch(
      voiding,
      { op: "void", reason: voidReason.trim() || undefined },
      { voidedAt: new Date().toISOString(), voidedBy: s.me, voidReason: voidReason.trim() || null },
      { reload: true }
    );
    setVoiding(null);
    setVoidReason("");
  };

  const setPrice = (m: FaceMark, value: string | null) => {
    const v = value === null ? null : Number(value);
    if (v !== null && (!Number.isFinite(v) || v < 0)) return;
    const used = usedOn(m.id)[0]?.productId ?? null;
    const list = feeOf(pickFacePrice(s.prices, m.treatmentKey, used)?.price ?? null, m.quantity ?? 1);
    patch(m, { op: "fee", fee: v }, { fee: v ?? list, feeManual: v !== null }, { failed: F.priceFailed });
    setPricing(null);
  };

  const saveNote = (m: FaceMark, value: string) => {
    patch(m, { op: "note", note: value.trim() }, { note: value.trim() }, { done: F.noteSaved });
    setNoting(null);
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

  const action = "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold hover:bg-sunken";

  // A plain function, not a component: a component made here would be a new type each render, and remount — a box being typed in would lose its cursor.
  const row = (m: FaceMark, compact?: boolean) => {
    const isSale = m.treatmentKey === PACKAGE_KEY;
    const mine = m.recordedBy.id === s.me.id && now - new Date(m.createdAt).getTime() < UNDO_MS;
    const billed = billedIds.has(m.id);
    const session = itemOf.get(m.id);
    const used = usedOn(m.id);
    const meta = [
      fmtDate(m.doneAt ?? m.createdAt, tz, locale),
      isSale ? null : amountOf(m),
      ...used.map((u) => `${u.name} · ${productAmount(u.unit, u.qty, "en")}${u.cost != null ? ` (${money(u.cost)})` : ""}`),
      m.performedBy ? F.by.replace("{name}", m.performedBy.name) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li key={m.id} className={`flex items-start gap-2.5 py-2.5 ${m.voidedAt ? "opacity-60" : ""}`} data-face-entry={m.id} data-voided={m.voidedAt ? "" : undefined}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold">
            {isSale ? <span className="inline-flex h-5 items-center rounded-md border border-line-strong bg-sunken px-1.5 text-[11px] font-semibold">{F.packageEntry}</span> : <FamilyTag family={m.family} label={F.families[m.family]} />}
            <span className={m.voidedAt ? "line-through" : ""}>{m.label}</span>
            {m.voidedAt && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{F.voided}</span>}
            {billed && !m.voidedAt && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{F.billed}</span>}
          </div>
          {!isSale && <div className="text-[13px] text-ink-700">{whereText(m.areas.map((a) => a.zone), "en")}</div>}
          {session && (
            <div className="text-[12.5px] font-medium text-ink-700" data-face-session={m.id}>
              {F.sessionFrom.replace("{package}", session.pkg.name)} · {F.sessionOf.replace("{n}", String(session.n)).replace("{total}", String(session.total))}
            </div>
          )}
          <div className="text-[12px] text-ink-500 tnum">{meta}</div>
          {m.note && !compact && noting?.id !== m.id && <div className="mt-0.5 whitespace-pre-line text-[12.5px] text-ink-700">{m.note}</div>}
          {m.voidedAt && m.voidReason && !compact && <div className="text-[12px] text-ink-500">{m.voidReason}</div>}
          {!m.voidedAt && dueAgain?.id === m.id && (
            <span className="mt-1 inline-block rounded-full bg-brand-50 px-2.5 py-0.5 text-[12px] font-semibold text-brand-700" data-due-again>
              {dueAgain.text}
            </span>
          )}
          {noting?.id === m.id && !compact && (
            <div className="mt-2 grid gap-2">
              <Textarea value={noting.value} onChange={(e) => setNoting({ id: m.id, value: e.target.value })} maxLength={2000} className="min-h-16" autoFocus aria-label={F.note} />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => saveNote(m, noting.value)} data-face-note-save={m.id}>
                  {F.saveNote}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNoting(null)}>
                  {F.cancel}
                </Button>
              </div>
            </div>
          )}
          {/* This patient's price, set by hand — before it is billed. */}
          {pricing?.id === m.id && !compact && (
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
          {!compact && <span className="text-[13px] font-semibold tnum">{session ? F.covered : m.fee != null ? money(m.fee) : "—"}</span>}
          {!m.voidedAt && (
            <div className="flex flex-wrap justify-end gap-1">
              {s.canWrite && FACE_TREATMENT_BY_KEY.has(m.treatmentKey) && (
                <button type="button" onClick={() => start(m.treatmentKey, m)} className={`${action} text-brand-700`} aria-label={F.repeatOf.replace("{treatment}", m.label)} data-face-repeat={m.id}>
                  <Repeat2 className="h-3.5 w-3.5" />
                  {F.repeat}
                </button>
              )}
              {!compact && s.canWrite && noting?.id !== m.id && (
                <button type="button" onClick={() => setNoting({ id: m.id, value: m.note })} className={`${action} text-ink-500`} data-face-note={m.id}>
                  {F.editNote}
                </button>
              )}
              {!compact && mine && s.canWrite && !billed && (
                <button type="button" onClick={() => undo(m)} className={`${action} text-ink-500`} data-face-undo={m.id}>
                  <Undo2 className="h-3.5 w-3.5" />
                  {F.undo}
                </button>
              )}
              {!compact && (s.canWrite || s.canBill) && !billed && !session && pricing?.id !== m.id && (
                <button type="button" onClick={() => setPricing({ id: m.id, value: m.fee != null ? String(m.fee) : "" })} className={`${action} text-ink-500`} data-face-price={m.id}>
                  {F.editPrice}
                </button>
              )}
              {!compact && s.canWrite && !mine && (
                <button type="button" onClick={() => setVoiding(m)} className={`${action} text-ink-500 hover:bg-danger-soft hover:text-danger`} data-face-void={m.id}>
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
  const stepBtn = "h-9 w-9 shrink-0 rounded-ctl border border-line-strong text-[17px] hover:bg-sunken";
  const stepper = (label: string, value: number, set: (n: number) => void, min = 1) => (
    <div className="flex items-center gap-2.5">
      <span className="flex-1 text-[13.5px] font-semibold">{label}</span>
      <button type="button" onClick={() => set(Math.max(min, value - 1))} aria-label={F.less} className={stepBtn}>
        −
      </button>
      <span className="w-10 text-center text-[15px] font-bold tnum">{value}</span>
      <button type="button" onClick={() => set(value + 1)} aria-label={F.oneMore} className={stepBtn}>
        +
      </button>
    </div>
  );
  const heading = "text-[12px] font-semibold uppercase tracking-wide text-ink-500";

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
          <FaceMap selected={sel} tints={tints} showAreas={showAreas} onToggle={toggleZone} labels={{ right: F.patientRight, left: F.patientLeft }} />
          <div className="mt-3 flex flex-wrap justify-center gap-1.5 border-t border-line pt-3">
            {FAMILIES.map((f) => (
              <FamilyTag key={f} family={f} label={F.families[f]} />
            ))}
          </div>
        </Card>

        {/* What was done */}
        <Card className="p-4">
          {!sel.length && (
            <div data-face-panel="idle">
              <h3 className="text-[16px] font-semibold">{F.addTitle}</h3>
              <p className="mt-0.5 text-[13px] text-ink-500">{s.canWrite ? F.addHint : F.readOnly}</p>
              <h4 className={`mt-4 ${heading}`}>{F.recent}</h4>
              {recent.length ? <ul className="divide-y divide-line">{recent.map((m) => row(m, true))}</ul> : <p className="mt-1 text-[13px] text-ink-500">{F.nothingYet}</p>}
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

              <h4 className={`mt-4 ${heading}`}>{F.doneHere}</h4>
              {here.length ? <ul className="divide-y divide-line">{here.map((m) => row(m, true))}</ul> : <p className="mt-1 text-[13px] text-ink-500">{F.nothingHere}</p>}

              {s.canWrite && (
                <>
                  <h4 className={`mt-4 ${heading}`}>{F.whatDone}</h4>
                  {fits.length ? (
                    <div className="mt-2 grid grid-cols-2 gap-2" data-face-fits={fits.length}>
                      {fits.map((x) => {
                        const p = pickFacePrice(s.prices, x.key, null);
                        return (
                          <button
                            key={x.key}
                            type="button"
                            onClick={() => start(x.key)}
                            className="flex min-h-14 flex-col items-start justify-center gap-1 rounded-ctl border border-line-strong px-3 py-2 text-start hover:bg-sunken"
                            data-face-treatment={x.key}
                          >
                            <span className="text-[13.5px] font-semibold">{x.en}</span>
                            <span className="flex flex-wrap items-center gap-1.5">
                              <FamilyTag family={x.family} label={F.families[x.family]} />
                              <span className="text-[12px] text-ink-500 tnum">{p ? `${money(p.price)} ${F.pricedBy[x.pricedBy]}` : F.noPrice}</span>
                            </span>
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
                  <h3 className="flex flex-wrap items-center gap-2 text-[16px] font-semibold">
                    {tr.en}
                    <FamilyTag family={tr.family} label={F.families[tr.family]} />
                  </h3>
                  <div className="text-[13px] text-ink-700">{whereText(sel, "en")}</div>
                </div>
                <Button size="sm" variant="outline" className="ms-auto shrink-0" onClick={() => setTKey(null)}>
                  {F.change}
                </Button>
              </div>

              {tr.units && (
                <div>
                  <h4 className={heading}>{F.unitsPerArea}</h4>
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
                            className={stepBtn}
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
                            className={stepBtn}
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

              {/* The product, from what the clinic keeps for this treatment. */}
              <div>
                <h4 className={heading}>{F.product}</h4>
                {productsFor(tr.key).length ? (
                  <div className="mt-1.5 grid gap-1.5" data-face-products>
                    {productsFor(tr.key).map((p) => {
                      const on = p.id === productId;
                      const low = p.onHand > 0 && p.lowStock != null && p.onHand <= p.lowStock;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            setProductId(on ? "" : p.id);
                            setQtyText(null);
                          }}
                          className={`flex items-center gap-2.5 rounded-ctl border px-3 py-2 text-start ${on ? "border-2 border-brand-600 bg-sunken" : "border-line-strong hover:bg-sunken"}`}
                          data-face-product={p.id}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13.5px] font-semibold">
                              {p.name}
                              {p.company && <span className="font-normal text-ink-500"> · {p.company}</span>}
                            </span>
                            {p.next && (
                              <span className="block text-[12px] text-ink-500">
                                {p.next.lot
                                  ? F.nextLot.replace("{lot}", p.next.lot).replace("{date}", p.next.expiresOn ? fmtDateOnly(p.next.expiresOn, "en") : "—")
                                  : F.nextBatch.replace("{date}", p.next.expiresOn ? fmtDateOnly(p.next.expiresOn, "en") : "—")}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 text-end text-[12.5px] font-semibold tnum">
                            {p.onHand > 0 ? F.onHand.replace("{n}", productAmount(p.unit, p.onHand, "en")) : <span className="text-danger">{F.noneOnHand}</span>}
                            {low && <span className="block text-[11px] text-ink-500">{F.low}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mt-1 text-[13px] text-ink-500">
                    {F.noProductsYet}{" "}
                    {s.canStock && (
                      <Link href={`/c/${s.slug}/stock`} className="font-semibold text-brand-700 hover:underline">
                        {F.addProducts}
                      </Link>
                    )}
                  </p>
                )}
                {product && (
                  <div className="mt-2 flex items-center gap-2.5">
                    <span className="flex-1 text-[13.5px] font-semibold">{F.amountUsed}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={qtyText ?? String(defaultQty)}
                      onChange={(e) => /^\d{0,5}(\.\d{0,2})?$/.test(e.target.value) && setQtyText(e.target.value)}
                      className="h-9 w-20 shrink-0 rounded-ctl border border-line-strong bg-surface text-center text-base font-semibold tnum focus:border-brand-600 focus:outline-none md:text-sm"
                      aria-label={F.amountUsed}
                      data-face-qty
                    />
                    <span className="w-16 shrink-0 text-[12.5px] text-ink-500">{productAmount(product.unit, 2, "en").replace(/^2\s?/, "")}</span>
                  </div>
                )}
                {preview?.short && <p className="mt-1 text-[12px] text-ink-500">{F.usedWithout}</p>}
              </div>

              {covering && (
                <button
                  type="button"
                  aria-pressed={fromPackage}
                  onClick={() => setFromPackage((v) => !v)}
                  className={`flex items-center gap-2.5 rounded-ctl border px-3 py-2.5 text-start ${fromPackage ? "border-2 border-brand-600 bg-sunken" : "border-line-strong hover:bg-sunken"}`}
                  data-face-from-package={covering.item.id}
                >
                  <span className={`h-5 w-5 shrink-0 rounded-[5px] border-2 border-brand-600 ${fromPackage ? "bg-brand-600" : ""}`} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{F.fromPackage.replace("{name}", covering.pkg.name)}</span>
                    <span className="block text-[12px] text-ink-500">
                      {F.sessionOf.replace("{n}", String(covering.item.used + 1)).replace("{total}", String(covering.item.sessions))}
                    </span>
                  </span>
                </button>
              )}

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
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={F.notePlaceholder} maxLength={2000} className="min-h-16" data-face-note-input />
              </label>

              <div className="grid gap-1.5 rounded-ctl bg-sunken px-3.5 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1">
                    <span className="text-[13.5px] font-semibold">{F.price}</span>
                    <span className="block text-[12px] text-ink-500 tnum">
                      {covered && worth != null
                        ? F.worth.replace("{amount}", money(worth))
                        : listPrice
                          ? `${amountText(tr.pricedBy, quantity, "en")} × ${money(listPrice.price)}`
                          : F.noPrice}
                    </span>
                  </span>
                  {covered ? (
                    <span className="text-[14px] font-bold" data-face-fee="0">
                      {F.covered}
                    </span>
                  ) : fee != null ? (
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
                {s.canStock && preview && (
                  <>
                    <div className="flex items-baseline gap-2 text-[13px]">
                      <span className="flex-1">{F.productCost}</span>
                      <span className="font-semibold tnum" data-face-cost={preview.cost}>
                        − {money(preview.cost)}
                      </span>
                    </div>
                    {!covered && fee != null && (
                      <div className="flex items-baseline gap-2 border-t border-line pt-1.5 text-[13px]">
                        <span className="flex-1">
                          {F.leftAfter}
                          <span className="block text-[11.5px] text-ink-500">{F.leftHint}</span>
                        </span>
                        <span className="font-bold tnum">{money(Math.max(0, fee - preview.cost))}</span>
                      </div>
                    )}
                  </>
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

      {/* The patient's packages: what each holds, used and left. */}
      {(s.packages.length > 0 || (s.canSell && s.plans.length > 0)) && (
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold">{F.packages}</h3>
            {s.canSell && (
              <Button size="sm" variant="outline" className="ms-auto" onClick={() => setSelling(true)} data-face-sell>
                <PackagePlus className="h-4 w-4" />
                {F.sellPackage}
              </Button>
            )}
          </div>
          {s.packages.length === 0 ? (
            <p className="mt-1 text-[13px] text-ink-500">{F.noPackages}</p>
          ) : (
            <ul className="mt-2 grid gap-2.5" data-face-packages={s.packages.length}>
              {s.packages.map((p) => {
                const ran = !!p.expiresOn && p.expiresOn < today;
                return (
                  <li key={p.id} className={`rounded-ctl border border-line px-3 py-2.5 ${p.voided ? "opacity-60" : ""}`} data-face-package={p.id}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={`text-[14px] font-semibold ${p.voided ? "line-through" : ""}`}>{p.name}</span>
                      <span className="text-[12.5px] text-ink-500 tnum">· {money(p.price)}</span>
                      <span className="ms-auto text-[12px] text-ink-500">
                        {p.voided
                          ? F.packageVoided
                          : p.expiresOn
                            ? (ran ? F.expiredOn : F.goodUntil).replace("{date}", fmtDateOnly(p.expiresOn, "en"))
                            : F.noEnd}
                      </span>
                    </div>
                    <div className="mt-1.5 grid gap-1.5">
                      {p.items.map((i) => {
                        const x = FACE_TREATMENT_BY_KEY.get(i.treatmentKey);
                        return (
                          <div key={i.id} className="flex items-center gap-2" data-face-package-item={i.id} data-used={i.used}>
                            <span className="min-w-0 flex-[0_1_12rem] truncate text-[12.5px]">{x?.en ?? i.treatmentKey}</span>
                            {/* A session done, in its treatment's colour; one to come, in the line's. */}
                            <span className="flex min-w-0 flex-1 gap-0.5" aria-hidden>
                              {Array.from({ length: i.sessions }, (_, n) => (
                                <span
                                  key={n}
                                  className="h-2 min-w-0 flex-1 rounded-[2px]"
                                  style={{ background: n < i.used ? (x ? FAMILY_COLOR[x.family] : "var(--color-ink-500)") : "var(--color-line)" }}
                                />
                              ))}
                            </span>
                            <span className="shrink-0 text-[12px] text-ink-500 tnum">{F.used.replace("{used}", String(i.used)).replace("{total}", String(i.sessions))}</span>
                          </div>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

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
            {shown.map((m) => row(m))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-ink-500">{F.nothingYet}</p>
        )}
      </Card>

      <ConfirmDialog open={!!voiding} onClose={() => setVoiding(null)} onConfirm={voidIt} title={F.voidTitle} body={F.voidBody} confirmLabel={F.voidAction} cancelLabel={F.cancel}>
        <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={F.voidReason} maxLength={300} aria-label={F.voidReason} />
      </ConfirmDialog>

      {selling && <SellPackage base={base} onClose={() => setSelling(false)} />}
    </div>
  );
}

function SellPackage({ base, onClose }: { base: string; onClose: () => void }) {
  const s = useFaceStore();
  const { t, locale } = useI18n();
  const F = t.face;
  const { toast } = useToast();
  const [planId, setPlanId] = useState(s.plans[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const sell = async () => {
    const plan = s.plans.find((p) => p.id === planId);
    if (!plan) return;
    setBusy(true);
    const id = newId();
    try {
      const r = await s.write(
        [id],
        call<{ mark: FaceMark; events: MarkEvent[]; package: PatientPackage }>(`${base}/packages`, "POST", { id, eventId: newId(), planId, note: note.trim() })
      );
      s.setMarks((prev) => [...prev, r.mark]);
      s.setEvents((prev) => [...prev, ...r.events]);
      s.setPackages((prev) => [...prev, r.package]);
      toast(s.canBill ? F.sold : F.soldOnly);
      onClose();
    } catch {
      toast(F.saveFailed, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={F.sellTitle}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {F.cancel}
          </Button>
          <Button onClick={() => void sell()} loading={busy} disabled={!planId} data-face-sell-save>
            {F.sell}
          </Button>
        </>
      }
    >
      {s.plans.length === 0 ? (
        <p className="text-[13px] text-ink-500">
          {F.noPlans}{" "}
          {s.canPrice && (
            <Link href={`/c/${s.slug}/settings/face-packages`} className="font-semibold text-brand-700 hover:underline">
              {F.setUpPackages}
            </Link>
          )}
        </p>
      ) : (
        <div className="grid gap-2" role="radiogroup" aria-label={F.sellTitle}>
          {s.plans.map((p) => {
            const on = p.id === planId;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPlanId(p.id)}
                className={`rounded-ctl border px-3 py-2.5 text-start ${on ? "border-2 border-brand-600 bg-sunken" : "border-line-strong hover:bg-sunken"}`}
                data-face-plan={p.id}
              >
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 text-[14px] font-semibold">{p.name}</span>
                  <span className="text-[14px] font-bold tnum">{fmtMoney(p.price, s.currency, locale)}</span>
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {p.items.map((i, n) => {
                    const x = FACE_TREATMENT_BY_KEY.get(i.treatmentKey);
                    return x ? <FamilyTag key={n} family={x.family} label={`${x.en} × ${i.sessions}`} /> : null;
                  })}
                </span>
              </button>
            );
          })}
          <label className="mt-1 grid gap-1 text-[12.5px] font-semibold text-ink-500">
            {F.note}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="min-h-14" />
          </label>
        </div>
      )}
    </Modal>
  );
}
