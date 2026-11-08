"use client";

/*
  The face chart tab: aesthetic work on the patient's face, saved.

  Tap the exact spots treated, pick what was done, say how much and with which
  product, save. Where the doctor worked is chosen by dots alone (Yamen,
  2026-11-08); the part of the face each is in follows from where it is. Four taps for a routine Botox. Each saved treatment is
  drawn at once and stored behind it with an id the browser chose, so the
  tinted area and the row are the same entry from the start; if the server
  refuses, the tint goes and the chart says so. Saved work is on Ready to bill
  for reception, priced from the clinic's list — or covered by one of the
  patient's packages, with no new charge.

  Tapping a part also shows everything done there before, with Repeat — what
  a doctor needs most at a Botox touch-up. Every note written here, and every
  note edited later, is in the patient's Notes too (notes-feed.tsx).

  Who may record is `patients.charts`; everybody else who can open the file
  reads the chart and its history. Colour says what kind of work it was. The
  spots themselves are dots on the face, and tapping one says what was done
  there, when and by whom (Yamen, 2026-11-08, after 2026-10-28's tints alone).
*/

import { useMemo, useState } from "react";
import { CornerDownRight } from "lucide-react";
import Link from "next/link";
import { PackagePlus, Plus, Repeat2, Undo2, X } from "lucide-react";
import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Input, Select, Textarea } from "@/components/ui/input";
import { fmtDate, fmtDateOnly, fmtMoney } from "@/lib/dates";
import {
  DEFAULT_UNITS,
  FAMILIES,
  FAMILY_COLOR,
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
  type FaceVariant,
  type PricedBy,
  FACE_ZONES,
  FACE_VIEWS,
  treatmentColor,
  VIEW_NAME,
  VIEW_SHORT,
  zoneAt,
  type FaceView,
} from "@/lib/charts/face/catalog";
import type { FaceMark } from "@/lib/charts/face/db";
import type { StockProduct } from "@/lib/charts/face/stock";
import { PACKAGE_KEY, type PatientPackage } from "@/lib/charts/face/packages";
import type { MarkEvent } from "@/lib/charts/dental/state";
import { call, newId, useFaceStore } from "@/components/charts/face/store";
import { FaceMap, type PastPoint, type PendingPoint } from "@/components/charts/face/face-map";
import { FaceReadyToBill } from "@/components/charts/face/ready-to-bill";
import { FamilyTag } from "@/components/charts/face/family-tag";
import { AddTreatment, treatmentsCall } from "@/components/charts/face/add-treatment";

/** The middle of a part on the front picture: where work recorded on a whole part, before dots, is drawn. */
function centreOf(zone: string): { x: number; y: number; v: "front" } | null {
  const z = ZONE_BY_KEY.get(zone);
  return z ? { x: z.x, y: z.y, v: "front" } : null;
}

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

/** What a product would cost for so much, taken as the chart takes it: the batch that expires first, then the next, expired ones last. */
function costPreview(p: StockProduct, qty: number): { cost: number; short: boolean } {
  let left = qty;
  let cost = 0;
  for (const b of [...p.batches].sort((x, y) => Number(x.expired) - Number(y.expired))) {
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

  // Parts chosen whole (quick picks, the keyboard), and exact spots tapped; the parts recorded are both.

  const [pts, setPts] = useState<PendingPoint[]>([]);
  const sel = useMemo(() => inFaceOrder([...new Set(pts.map((p) => p.zone))].map((zone) => ({ zone }))).map((a) => a.zone), [pts]);
  // A past spot whose card is open, and whether past spots are drawn at all.
  const [spot, setSpot] = useState<(PastPoint & { at: { x: number; y: number } }) | null>(null);
  // The picture in front of the doctor: the face from the front, or turned.
  const [view, setView] = useState<FaceView>("front");
  const [showPast, setShowPast] = useState(true);
  // The treatment list: what is usual for the parts chosen first, the rest a tap away, or found by name.
  const [findT, setFindT] = useState("");
  const [tKey, setTKey] = useState<string | null>(null);
  const [units, setUnits] = useState<Record<string, number>>({});
  const [count, setCount] = useState(1);
  const [doer, setDoer] = useState<string>(() => (s.myMemberId && s.doctors.some((d) => d.id === s.myMemberId) ? s.myMemberId : ""));
  const [note, setNote] = useState("");
  const [productId, setProductId] = useState<string>("");
  const [qtyText, setQtyText] = useState<string | null>(null);
  const [fromPackage, setFromPackage] = useState(true);
  const [showVoided, setShowVoided] = useState(false);
  const [voiding, setVoiding] = useState<FaceMark | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [pricing, setPricing] = useState<{ id: string; value: string } | null>(null);
  const [noting, setNoting] = useState<{ id: string; value: string } | null>(null);
  const [selling, setSelling] = useState(false);
  const [now] = useState(() => Date.now());

  const tr = tKey ? (s.catalog.byKey.get(tKey) ?? null) : null;
  const [variantId, setVariantId] = useState("");
  // The price as the doctor typed it; null means the list's.
  const [priceText, setPriceText] = useState<string | null>(null);
  const [retouchOf, setRetouchOf] = useState<FaceMark | null>(null);
  const [adding, setAdding] = useState(false);
  const kinds = tr ? s.variants.filter((v) => v.treatmentKey === tr.key && v.active) : [];
  const variant = kinds.find((v) => v.id === variantId) ?? null;
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

  /*
    Every spot recorded, as a dot in its kind of work's colour. Work recorded on a
    whole part, before dots, is a dot in the middle of that part on the front, so
    it can still be found and opened.
  */
  const pastPoints = useMemo<PastPoint[]>(
    () =>
      showPast
        ? live.flatMap((m) =>
            m.areas.flatMap((a, ai) => {
              const spots = a.points?.length ? a.points : [centreOf(a.zone)].filter((c) => c !== null);
              const color = treatmentColor(s.catalog.byKey.get(m.treatmentKey), m.family);
              return spots.map((p, pi) => ({ key: `${m.id}:${ai}:${pi}`, markId: m.id, zone: a.zone, x: p.x, y: p.y, v: p.v ?? "front", color }));
            })
          )
        : [],
    [live, showPast, s.catalog]
  );

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

  // An exact spot. Its part joins the treatment, at that part's usual units.
  const addPoint = (p: PendingPoint) => {
    setSpot(null);
    if (tr?.units && !sel.includes(p.zone)) setUnits((u) => ({ ...u, [p.zone]: unitsFor(p.zone) }));
    setPts((x) => [...x, p]);
  };
  const removePoint = (i: number) => {
    const next = pts.filter((_, j) => j !== i);
    setPts(next);
    if (!next.length) setTKey(null);
  };

  const clear = () => {
    setPts([]);
    setTKey(null);
    setFindT("");
  };

  // `given` is a treatment made a moment ago, before the catalog this render read has it.
  const start = (k: string, from?: FaceMark, given?: FaceTreatment, retouch?: boolean) => {
    const t2 = given ?? s.catalog.byKey.get(k);
    if (!t2 || t2.archived) return;
    // A retouch has no list price: the doctor says what it costs, 0 if it is free.
    setRetouchOf(retouch && from ? from : null);
    setPriceText(retouch ? "" : null);
    // The kind done last time, when it was a repeat.
    setVariantId(from?.detail.variant?.id ?? "");
    const zones = from ? from.areas.map((a) => a.zone) : sel;
    // A repeat is on the same spots; a part recorded whole, before dots, is a dot in its middle.
    if (from) {
      setPts(
        from.areas.flatMap((a) =>
          a.points?.length
            ? a.points.map((p) => ({ x: p.x, y: p.y, zone: a.zone, v: p.v ?? "front" }))
            : [centreOf(a.zone)].filter((c) => c !== null).map((c) => ({ x: c.x, y: c.y, zone: a.zone, v: "front" as const }))
        )
      );
      // On the picture its points were marked on.
      const firstView = from.areas.flatMap((a) => a.points ?? [])[0]?.v;
      if (firstView) setView(firstView);
    }
    setSpot(null);
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

  /*
    Every treatment, those usual on more of the parts chosen first. Usual on any of
    them counts: crow's feet and a tear trough together are a toxin and a filler,
    neither of which is usual on both, and asking for both hid the two most common.
  */
  const fits = useMemo(() => {
    if (!sel.length) return [];
    return s.catalog.offered
      .map((x, i) => ({ x, i, n: sel.filter((z) => x.fits.includes(z)).length }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .map((e) => e.x);
  }, [sel, s.catalog]);
  // Typed as staff say it: "botox", "فيلر", a brand.
  const term = findT.trim().toLowerCase();
  // Every treatment is always offered, the usual ones first: one kept behind a button was one a doctor could not find (11-08).
  const shownFits = term ? fits.filter((x) => [x.en, x.ar, ...(x.aliases ?? [])].some((w) => w.toLowerCase().includes(term))) : fits;
  const here = useMemo(() => newestFirst.filter((m) => !m.voidedAt && m.areas.some((a) => sel.includes(a.zone))), [newestFirst, sel]);

  /* ---- the record panel's numbers ---- */

  const areasNow = (x: FaceTreatment): Area[] =>
    inFaceOrder(
      sel.map((z) => {
        const here = pts.filter((p) => p.zone === z).map(({ x: px, y: py, v }) => ({ x: px, y: py, v }));
        return { zone: z, ...(x.units ? { units: units[z] ?? 0 } : {}), ...(here.length ? { points: here } : {}) };
      })
    );
  const areasPreview = tr ? areasNow(tr) : [];
  const quantity = tr ? quantityOf(tr, areasPreview, count) : 0;
  const unitsTotal = tr ? totalUnits(tr, areasPreview) : null;
  const product = tr && productId ? (s.products.find((p) => p.id === productId && p.treatments.includes(tr.key)) ?? null) : null;
  const defaultQty = !product ? 0 : product.unit === "u" ? (unitsTotal ?? 0) : product.unit === tr?.pricedBy ? count : 1;
  const qty = product ? (qtyText === null ? defaultQty : Number(qtyText) || 0) : 0;
  const preview = product && qty > 0 ? costPreview(product, qty) : null;
  const covering = tr ? usableItem(s.packages, tr.key, today) : null;
  const covered = !!covering && fromPackage;
  const listPrice = tr ? pickFacePrice(s.prices, tr.key, product?.id ?? null, variant?.id ?? null) : null;
  const listFee = tr ? feeOf(listPrice?.price ?? null, quantity) : null;
  const typedFee = priceText === null || priceText.trim() === "" ? null : Number(priceText);
  const fee = tr ? (covered ? 0 : priceText !== null ? typedFee : listFee) : null;
  const priceMissing = !!retouchOf && !covered && (typedFee == null || Number.isNaN(typedFee));
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
      detail: { pricedBy: tr.pricedBy, units: !!tr.units, ...(variant ? { variant: { id: variant.id, name: variant.name, nameAr: variant.nameAr } } : {}) },
      label: tr.en,
      labelAr: tr.ar,
      family: tr.family,
      areas,
      quantity,
      fee,
      feeManual: priceText !== null && !covered,
      serviceId: listPrice?.serviceId ?? null,
      redoOf: retouchOf?.id ?? null,
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
        variantId: variant?.id ?? null,
        fee: priceText !== null && !covered ? typedFee : null,
        retouchOf: retouchOf?.id ?? null,
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
    const x = s.catalog.byKey.get(m.treatmentKey);
    const parts: string[] = [];
    if (x && x.pricedBy !== "session" && m.quantity != null) parts.push(amountText(x.pricedBy, m.quantity, "en"));
    const u = x ? totalUnits(x, m.areas) : null;
    if (u) parts.push(unitsText(u, "en"));
    return parts.join(" · ");
  };

  const action = "inline-flex h-9 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-semibold hover:bg-sunken sm:h-7 sm:text-[12px]";

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
      ...used.map((u) => `${u.name}${u.lots.length ? ` ${u.lots.join(", ")}` : ""} · ${productAmount(u.unit, u.qty, "en")}${u.cost != null ? ` (${money(u.cost)})` : ""}`),
      m.performedBy ? F.by.replace("{name}", m.performedBy.name) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <li key={m.id} className={`py-2.5 ${m.voidedAt ? "opacity-60" : ""}`} data-face-entry={m.id} data-voided={m.voidedAt ? "" : undefined}>
        <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold">
            {isSale ? <span className="inline-flex h-5 items-center rounded-md border border-line-strong bg-sunken px-1.5 text-[11px] font-semibold">{F.packageEntry}</span> : <FamilyTag family={m.family} label={F.families[m.family]} />}
            <span className={m.voidedAt ? "line-through" : ""}>{m.label}</span>
            {m.voidedAt && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{F.voided}</span>}
            {billed && !m.voidedAt && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{F.billed}</span>}
          </div>
          {!isSale && <div className="text-[13px] text-ink-700">{whereText(m.areas.map((a) => a.zone), "en")}</div>}
          {(() => {
            const orig = m.redoOf ? s.marks.find((x) => x.id === m.redoOf) : null;
            const times = work.filter((x) => x.redoOf === m.id && !x.voidedAt).length;
            return (
              <>
                {orig && <div className="text-[12.5px] font-medium text-brand-700" data-face-retouch-of={m.id}>{F.retouchOf.replace("{date}", fmtDate(orig.doneAt ?? orig.createdAt, tz, locale))}</div>}
                {times > 0 && <div className="text-[12.5px] font-medium text-ink-700" data-face-retouched={times}>{F.retouched.replace("{n}", String(times))}</div>}
              </>
            );
          })()}
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
          {!compact && <span className="shrink-0 text-[13px] font-semibold tnum">{session ? F.covered : m.fee != null ? money(m.fee) : "—"}</span>}
        </div>
          {/* Under the entry, in a row that wraps: beside it, they squeezed its words to a column on a phone. */}
          {!m.voidedAt && (
            <div className="-ms-2.5 mt-1 flex flex-wrap gap-0.5" data-face-actions={m.id}>
              {s.canWrite && s.catalog.byKey.has(m.treatmentKey) && !s.catalog.byKey.get(m.treatmentKey)?.archived && (
<>
                <button type="button" onClick={() => start(m.treatmentKey, m)} className={`${action} text-brand-700`} aria-label={F.repeatOf.replace("{treatment}", m.label)} data-face-repeat={m.id}>
                  <Repeat2 className="h-3.5 w-3.5" />
                  {F.repeat}
                </button>
                <button type="button" onClick={() => start(m.treatmentKey, m, undefined, true)} className={`${action} text-brand-700`} data-face-retouch={m.id}>
                  <Undo2 className="h-3.5 w-3.5 -scale-x-100" />
                  {F.retouch}
                </button>
                </>
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
      </li>
    );
  };

  /**
   * What was done at a past spot: the card that opens on the face where the dot is,
   * toward the middle so it never runs off the picture.
   */
  const spotCard = (p: PastPoint & { at: { x: number; y: number } }) => {
    const m = s.marks.find((x) => x.id === p.markId);
    if (!m) return null;
    const area = m.areas.find((a) => a.zone === p.zone);
    const used = usedOn(m.id);
    const right = p.at.x > 0.5;
    const below = p.at.y < 0.55;
    // Beside the dot, toward the middle, and never past either edge of the picture.
    const w = "min(17rem, 92%)";
    return (
      <div
        className="absolute z-[4] rounded-card border border-line bg-surface p-3 text-start shadow-pop"
        style={{
          width: w,
          left: `clamp(0px, ${right ? `calc(${p.at.x * 100}% - ${w} - 10px)` : `calc(${p.at.x * 100}% + 10px)`}, calc(100% - ${w}))`,
          top: `${p.at.y * 100}%`,
          transform: `translateY(${below ? "10px" : "calc(-100% - 10px)"})`,
        }}
        onClick={(e) => e.stopPropagation()}
        data-face-spot={m.id}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold">
              {m.label}
              {m.detail.variant && <span className="font-normal text-ink-500">· {m.detail.variant.name}</span>}
            </div>
            <FamilyTag family={m.family} label={F.families[m.family]} />
          </div>
          <button type="button" onClick={() => setSpot(null)} aria-label={t.common.close} className="-me-1 -mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-sunken">
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="mt-2 grid gap-0.5 text-[12.5px] text-ink-700">
          <div>{fmtDate(m.doneAt ?? m.createdAt, tz, locale)}{m.performedBy ? ` · ${F.by.replace("{name}", m.performedBy.name)}` : ""}</div>
          {area && (
            <div>
              {area.units != null
                ? F.unitsHere.replace("{n}", String(area.units)).replace("{area}", ZONE_BY_KEY.get(area.zone)?.en ?? area.zone)
                : ZONE_BY_KEY.get(area.zone)?.en}
              {area.points && area.points.length > 1 ? ` · ${F.points.replace("{n}", String(area.points.length))}` : ""}
            </div>
          )}
          {used.map((u) => (
            <div key={u.productId}>
              {u.name}
              {u.lots.length ? ` · ${u.lots.join(", ")}` : ""}
            </div>
          ))}
          {m.redoOf && <div className="font-medium text-brand-700">{F.retouch}</div>}
          {m.note && <div className="line-clamp-3 whitespace-pre-line text-ink-500">{m.note}</div>}
        </dl>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {s.canWrite && (
            <button
              type="button"
              onClick={() => {
                const zone = zoneAt(p.x, p.y, p.v);
                if (zone) addPoint({ x: p.x, y: p.y, zone, v: p.v });
              }}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-brand-600 px-3 text-[12.5px] font-semibold text-on-brand"
              data-face-spot-again
            >
              <CornerDownRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
              {F.sameSpot}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setSpot(null);
              const el = document.querySelector(`[data-face-history] [data-face-entry="${m.id}"]`);
              el?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
            className="inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[12.5px] font-semibold hover:bg-sunken"
            data-face-spot-entry
          >
            {F.seeEntry}
          </button>
        </div>
      </div>
    );
  };

  // What is on this face, once each, in its colour: the key to its dots.
  const onFace = (() => {
    const seen = new Map<string, { key: string; name: string; color: string }>();
    for (const p of pastPoints) {
      const m = s.marks.find((x) => x.id === p.markId);
      if (m && !seen.has(m.treatmentKey)) seen.set(m.treatmentKey, { key: m.treatmentKey, name: s.catalog.byKey.get(m.treatmentKey)?.en ?? m.label, color: p.color });
    }
    return [...seen.values()];
  })();

  const toggles = (
    <>
      <button
        type="button"
        aria-pressed={showPast}
        onClick={() => (setShowPast((v) => !v), setSpot(null))}
        className={`inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[12.5px] font-medium ${showPast ? "bg-sunken" : "hover:bg-sunken"}`}
        data-face-show-past
      >
        {F.showPast}
      </button>
    </>
  );

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
          {/* The picture: from the front, or the head turned, each way, as it turns. */}
          <div className="mb-2 flex justify-center" role="tablist" aria-label={F.views}>
            <div className="flex w-full rounded-full bg-sunken p-0.5 sm:inline-flex sm:w-auto">
              {FACE_VIEWS.map((v) => {
                return (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={view === v}
                    onClick={() => (setView(v), setSpot(null))}
                    aria-label={VIEW_NAME[v]}
                    className={`relative flex min-h-9 min-w-0 flex-1 items-center justify-center whitespace-nowrap rounded-full px-1.5 text-[12.5px] font-semibold transition-colors sm:flex-none sm:px-3.5 ${
                      view === v ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-900"
                    }`}
                    data-face-view-tab={v}
                  >
                    <span className="sm:hidden">{VIEW_SHORT[v]}</span>
                    <span className="max-sm:hidden">{VIEW_NAME[v]}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <FaceMap
            view={view}
            points={pts}
            past={pastPoints}
            pastActive={!sel.length}
            openKey={spot?.key ?? null}
            onPoint={addPoint}
            onRemovePoint={removePoint}
            onPast={(p, at) => setSpot((cur) => (cur?.key === p.key ? null : { ...p, at }))}
            labels={{ right: F.patientRight, left: F.patientLeft, removePoint: F.removePoint, pastPoint: F.pastPoint, addPointIn: F.addPointIn }}
          >
            {spot && spotCard(spot)}
          </FaceMap>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5 border-t border-line pt-3">
            {onFace.map((t) => (
              <span key={t.key} className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2 text-[12px] font-medium" data-face-legend={t.key}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} aria-hidden />
                {t.name}
              </span>
            ))}
          </div>
          {/* What the face shows: rarely changed, so under it rather than above. */}
          <div className="mt-2.5 flex justify-center gap-1.5">{toggles}</div>
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
                <h3 className="text-[16px] font-semibold" data-face-points={pts.length}>
                  {pts.length === 1 ? F.onePoint : F.points.replace("{n}", String(pts.length))}
                </h3>
                <Button size="sm" variant="outline" className="ms-auto" onClick={clear}>
                  {F.clear}
                </Button>
              </div>
              {/* Where, in words; a dot comes off by tapping it on the face, or the last one here. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[13px] text-ink-700" data-face-where>{whereText(sel, "en")}</span>
                <button
                  type="button"
                  onClick={() => removePoint(pts.length - 1)}
                  className="inline-flex min-h-9 items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline"
                  data-face-undo-dot
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  {F.removeLast}
                </button>
              </div>

              <h4 className={`mt-4 ${heading}`}>{F.doneHere}</h4>
              {here.length ? <ul className="divide-y divide-line">{here.map((m) => row(m, true))}</ul> : <p className="mt-1 text-[13px] text-ink-500">{F.nothingHere}</p>}

              {s.canWrite && (
                <>
                  <h4 className={`mt-4 ${heading}`} data-face-what>
                    {F.whatDone}
                  </h4>
                  {fits.length > 8 && (
                    <input
                      type="search"
                      value={findT}
                      onChange={(e) => setFindT(e.target.value)}
                      placeholder={F.findTreatment}
                      aria-label={F.findTreatment}
                      dir="auto"
                      className="mt-2 h-10 w-full rounded-full border border-line bg-sunken px-4 text-base outline-none focus:border-brand-400 md:text-sm"
                      data-face-find
                    />
                  )}
                  {term && !shownFits.length && <p className="mt-2 text-[13px] text-ink-500">{F.noMatch}</p>}
                  {fits.length ? (
                    <div className="mt-2 grid grid-cols-2 gap-2" data-face-fits={fits.length}>
                      {shownFits.map((x) => {
                        const p = pickFacePrice(s.prices, x.key, null);
                        return (
                          <button
                            key={x.key}
                            type="button"
                            onClick={() => start(x.key)}
                            className="flex min-h-14 flex-col items-start justify-center gap-1 rounded-ctl border border-line-strong px-3 py-2 text-start hover:bg-sunken"
                            data-face-treatment={x.key}
                          >
                            <span className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: treatmentColor(x, x.family) }} aria-hidden />
                              {x.en}
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5">
                              <FamilyTag family={x.family} label={F.families[x.family]} />
                              <span className="text-[12px] text-ink-500 tnum">{p ? `${money(p.price)} ${F.pricedBy[x.pricedBy]}` : F.noPriceShort}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="mt-1 text-[13px] text-ink-500">{F.noneFits}</p>
                  )}
                  {/* The clinic's own, made at the chair: the thirteen are a start, not the list. */}
                  <Button size="sm" variant="outline" className="mt-2 min-h-10" onClick={() => setAdding(true)} data-face-add-treatment>
                    <Plus className="h-4 w-4" />
                    {F.addTreatment}
                  </Button>
                </>
              )}
              {adding && (
                <AddTreatment
                  slug={s.slug}
                  zones={sel}
                  onClose={() => setAdding(false)}
                  onAdded={(key, custom, variants, looks) => {
                    s.setTreatments(custom, variants, looks);
                    setAdding(false);
                    start(key, undefined, custom.find((c) => c.key === key));
                  }}
                />
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
                  {retouchOf && (
                    <div className="text-[12.5px] font-semibold text-brand-700" data-face-retouching>
                      {F.retouchOf.replace("{date}", fmtDate(retouchOf.doneAt ?? retouchOf.createdAt, tz, locale))} · {F.retouchHint}
                    </div>
                  )}
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

              <VariantPicker
                slug={s.slug}
                treatmentKey={tr.key}
                kinds={kinds}
                value={variantId}
                onChange={(id) => {
                  setVariantId(id);
                  // A kind can bring its product with it.
                  const v = kinds.find((k) => k.id === id);
                  if (v?.productId && productsFor(tr.key).some((p) => p.id === v.productId)) setProductId(v.productId);
                }}
                onAdded={(id, custom, variants) => {
                  s.setTreatments(custom, variants);
                  setVariantId(id);
                }}
              />

              {tr.pricedBy === "syringe" && stepper(F.count.syringe, count, setCount)}
              {tr.pricedBy === "thread" && stepper(F.count.thread, count, setCount)}

              {/* The product, from what the clinic keeps for this treatment. */}
              <div>
                <h4 className={heading}>{F.product}</h4>
                {productsFor(tr.key).length ? (
                  <div className="mt-1.5 grid gap-1.5" data-face-products>
                    {productsFor(tr.key).map((p) => {
                      const on = p.id === productId;
                      const low = p.usable > 0 && p.lowStock != null && p.usable <= p.lowStock;
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
                            {p.usable > 0 ? (
                              F.onHand.replace("{n}", productAmount(p.unit, p.usable, "en"))
                            ) : p.expired > 0 ? (
                              <span className="text-danger" data-face-product-expired>
                                {F.onlyExpired}
                              </span>
                            ) : (
                              <span className="text-danger">{F.noneOnHand}</span>
                            )}
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
                  ) : (
                    /* The doctor may set this patient's price here, and must for a retouch. */
                    <span className="flex items-center gap-1.5" data-face-fee={fee ?? ""}>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={priceText ?? (listFee != null ? String(listFee) : "")}
                        onChange={(e) => /^\d{0,7}(\.\d{0,2})?$/.test(e.target.value) && setPriceText(e.target.value)}
                        placeholder={retouchOf ? "0" : "—"}
                        aria-label={retouchOf ? F.retouchPrice : F.price}
                        className="h-10 w-24 rounded-ctl border border-line-strong bg-surface px-2 text-end text-base font-bold tnum focus:border-brand-600 focus:outline-none md:text-sm"
                        data-face-price-input
                      />
                      <span className="text-[12.5px] text-ink-500">{s.currency}</span>
                    </span>
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
                <Button className="flex-1" onClick={save} data-face-save disabled={(!!tr.units && (unitsTotal ?? 0) <= 0) || priceMissing}>
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

      {/*
        On a phone (and a tablet held upright) the face and what to do next are one
        above the other, and the next step was a scroll away every time: after the
        points, the treatments; after the units, Save. This bar keeps it under the
        thumb, above the tab bar.
      */}
      {s.canWrite && sel.length > 0 && (
        <>
          <div className="h-20 lg:hidden" aria-hidden />
          <div
            className="fixed inset-x-3 bottom-[calc(4.1rem+env(safe-area-inset-bottom))] z-30 flex items-center gap-2 rounded-card border border-line bg-surface/95 p-2 ps-3.5 shadow-pop backdrop-blur md:bottom-4 lg:hidden"
            data-face-bar={tr ? "save" : "choose"}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold">
                {tr ? tr.en : pts.length ? (pts.length === 1 ? F.onePoint : F.points.replace("{n}", String(pts.length))) : F.areas.replace("{n}", String(sel.length))}
              </div>
              <div className="truncate text-[12px] text-ink-500 tnum">{tr ? (covered ? F.covered : fee != null ? money(fee) : F.noPriceShort) : whereText(sel, "en")}</div>
            </div>
            {tr ? (
              <Button className="min-h-11 shrink-0 px-5" onClick={save} disabled={(!!tr.units && (unitsTotal ?? 0) <= 0) || priceMissing} data-face-bar-save>
                {F.save}
              </Button>
            ) : (
              <Button
                className="min-h-11 shrink-0"
                onClick={() => document.querySelector("[data-face-what]")?.scrollIntoView({ block: "start", behavior: "smooth" })}
                data-face-bar-choose
              >
                {F.chooseTreatment}
              </Button>
            )}
          </div>
        </>
      )}

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
                        const x = s.catalog.byKey.get(i.treatmentKey);
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

/**
 * The kind of work, when a treatment comes in kinds: TCA or glycolic, PDO or PLLA.
 * Optional, and a new kind is typed in place: the doctor is mid-treatment.
 */
function VariantPicker({
  slug,
  treatmentKey,
  kinds,
  value,
  onChange,
  onAdded,
}: {
  slug: string;
  treatmentKey: string;
  kinds: FaceVariant[];
  value: string;
  onChange: (id: string) => void;
  onAdded: (id: string, custom: FaceTreatment[], variants: FaceVariant[]) => void;
}) {
  const { t } = useI18n();
  const F = t.face;
  const { toast } = useToast();
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const add = async () => {
    if (!name.trim()) return;
    const r = await treatmentsCall(slug, { op: "variant", treatmentKey, name: name.trim() });
    if (!r.variantId) return toast(r.error === "exists" ? F.newTreatment.exists : t.common.genericError, "error");
    setName("");
    setTyping(false);
    onAdded(r.variantId, r.custom, r.variants);
  };
  const chip = (on: boolean) => `inline-flex min-h-9 items-center rounded-full border px-3 text-[13px] font-semibold ${on ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line-strong hover:bg-sunken"}`;
  return (
    <div data-face-variants>
      <h4 className="text-[12px] font-semibold uppercase tracking-wide text-ink-500">{F.variant}</h4>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button type="button" className={chip(!value)} onClick={() => onChange("")} aria-pressed={!value}>
          {F.variantAny}
        </button>
        {kinds.map((k) => (
          <button key={k.id} type="button" className={chip(value === k.id)} onClick={() => onChange(k.id)} aria-pressed={value === k.id} data-face-variant={k.name}>
            {k.name}
          </button>
        ))}
        {typing ? (
          <span className="flex items-center gap-1.5">
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void add())}
              placeholder={F.variantPlaceholder}
              maxLength={60}
              className="h-9 w-40"
              data-face-variant-name
            />
            <Button size="sm" onClick={() => void add()} disabled={!name.trim()} data-face-variant-save>
              {F.addVariant}
            </Button>
          </span>
        ) : (
          <button type="button" className="inline-flex min-h-9 items-center gap-1 px-2 text-[13px] font-semibold text-brand-700 hover:underline" onClick={() => setTyping(true)} data-face-variant-add>
            <Plus className="h-3.5 w-3.5" />
            {F.addVariant}
          </button>
        )}
      </div>
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
                    const x = s.catalog.byKey.get(i.treatmentKey);
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
