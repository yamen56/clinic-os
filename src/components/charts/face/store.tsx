"use client";

/*
  One face chart for the whole patient file.

  Held above the tabs, like the dental chart's store, so the Face chart tab
  and the Invoices tab draw the same treatments, and an entry survives the tab
  being closed and opened again. It reads the chart again only when the copy
  it holds may be old: a page brought back by the Back button, or a colleague
  recording on this patient from another screen. Never for its own writes —
  the tap has already been drawn.

  Kept free of the catalog and the picture, so the file that mounts it ships
  neither to clinics without the face chart.
*/

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useRealtimeRefresh, type RealtimeEvent } from "@/lib/use-realtime";
import type { FaceChartData, FaceMark, FacePrice } from "@/lib/charts/face/db";
import type { MarkProduct, StockProduct } from "@/lib/charts/face/stock";
import type { PackagePlan, PatientPackage } from "@/lib/charts/face/packages";
import type { MarkEvent } from "@/lib/charts/dental/state";
import type { Billed } from "@/lib/charts/dental/billing-server";

type Person = { id: string; name: string };

/** An id made in the browser, so what is drawn and what is stored are the same row from the start. */
export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));

/** A JSON call to the face chart's routes; throws with the server's error code. */
export async function call<T = Record<string, unknown>>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? `http_${res.status}`);
  return json;
}

/** What the patient page hands the face chart: the saved chart, and who is charting. */
export type FaceTabData = {
  me: Person;
  /** The signed-in member, so "done by" starts on the doctor at the chair. */
  myMemberId: string | null;
  doctors: Person[];
  /** May this member record on the chart (`patients.charts`)? */
  canWrite: boolean;
  /** May this member see what was billed and bill it (`invoices`)? */
  canBill: boolean;
  /** May this member set the clinic's prices (`settings.services`)? */
  canPrice: boolean;
  /** May this member sell a package (`patients.charts` or `invoices`)? */
  canSell: boolean;
  /** May this member see products, stock and what a product cost (`stock`)? */
  canStock: boolean;
  currency: string;
  chart: FaceChartData;
};

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export type FaceStore = Omit<FaceTabData, "chart"> & {
  slug: string;
  patientId: string;
  marks: FaceMark[];
  setMarks: Setter<FaceMark[]>;
  events: MarkEvent[];
  setEvents: Setter<MarkEvent[]>;
  prices: FacePrice[];
  billing: Billed[];
  products: StockProduct[];
  markProducts: MarkProduct[];
  setMarkProducts: Setter<MarkProduct[]>;
  packages: PatientPackage[];
  setPackages: Setter<PatientPackage[]>;
  plans: PackagePlan[];
  /** Send a write through the store: a re-read waits for it, and its echo is not taken for a colleague's change. */
  write<T>(ids: string[], p: Promise<T>): Promise<T>;
  reload(): Promise<void>;
};

const Ctx = createContext<FaceStore | null>(null);

export function useFaceStore(): FaceStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useFaceStore outside FaceProvider");
  return s;
}

/** The store when there is one — a file without the face chart has none. */
export function useOptionalFaceStore(): FaceStore | null {
  return useContext(Ctx);
}

/** An echo arrives within moments of the write; after this, a change to the same row is somebody else's. */
const MINE_FOR_MS = 15_000;
/** A page older than this when it mounts was restored from history, not freshly rendered. */
const STALE_AFTER_MS = 30_000;

export function FaceProvider({
  slug,
  patientId,
  data,
  renderedAt,
  children,
}: {
  slug: string;
  patientId: string;
  data: FaceTabData;
  renderedAt: number;
  children: React.ReactNode;
}) {
  const [marks, setMarks] = useState<FaceMark[]>(data.chart.marks);
  const [events, setEvents] = useState<MarkEvent[]>(data.chart.events);
  const [prices, setPrices] = useState<FacePrice[]>(data.chart.prices);
  const [billing, setBilling] = useState<Billed[]>(data.chart.billing);
  const [products, setProducts] = useState<StockProduct[]>(data.chart.products);
  const [markProducts, setMarkProducts] = useState<MarkProduct[]>(data.chart.markProducts);
  const [packages, setPackages] = useState<PatientPackage[]>(data.chart.packages);
  const [plans, setPlans] = useState<PackagePlan[]>(data.chart.plans);
  const sync = useRef({ inflight: 0, writes: 0, owed: false, mine: new Map<string, number>() });
  const [staleOnMount] = useState(() => Date.now() - renderedAt > STALE_AFTER_MS);

  const reload = useCallback(async () => {
    const s = sync.current;
    if (s.inflight > 0) {
      s.owed = true;
      return;
    }
    const startedAt = s.writes;
    const res = await fetch(`/api/c/${slug}/patients/${patientId}/face`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { ok?: boolean; chart?: FaceChartData } | null;
    if (!body?.ok || !body.chart) return;
    // A write began while this was on its way: what came back may not include it.
    if (s.writes !== startedAt || s.inflight > 0) {
      s.owed = true;
      return;
    }
    setMarks(body.chart.marks);
    setEvents(body.chart.events);
    setPrices(body.chart.prices);
    setBilling(body.chart.billing);
    setProducts(body.chart.products);
    setMarkProducts(body.chart.markProducts);
    setPackages(body.chart.packages);
    setPlans(body.chart.plans);
  }, [slug, patientId]);

  const write = useCallback(
    async <T,>(ids: string[], p: Promise<T>): Promise<T> => {
      const s = sync.current;
      const now = Date.now();
      for (const id of ids) s.mine.set(id, now);
      s.inflight++;
      s.writes++;
      try {
        return await p;
      } finally {
        s.inflight--;
        if (s.inflight === 0 && s.owed) {
          s.owed = false;
          void reload();
        }
      }
    },
    [reload]
  );

  const isOthers = useCallback(
    (e: RealtimeEvent) => {
      const ev = e as RealtimeEvent & { patient_id?: string };
      if (ev.patient_id && ev.patient_id !== patientId) return false;
      const t = ev.id ? sync.current.mine.get(ev.id) : undefined;
      return !(t && Date.now() - t < MINE_FOR_MS);
    },
    [patientId]
  );
  useRealtimeRefresh(slug, data.canBill ? ["chart_marks", "patient_packages", "invoices"] : ["chart_marks", "patient_packages"], reload, isOthers, {
    syncOnOpen: staleOnMount,
  });

  const value = useMemo<FaceStore>(
    () => ({
      slug,
      patientId,
      me: data.me,
      myMemberId: data.myMemberId,
      doctors: data.doctors,
      canWrite: data.canWrite,
      canBill: data.canBill,
      canPrice: data.canPrice,
      canSell: data.canSell,
      canStock: data.canStock,
      currency: data.currency,
      marks,
      setMarks,
      events,
      setEvents,
      prices,
      billing,
      products,
      markProducts,
      setMarkProducts,
      packages,
      setPackages,
      plans,
      write,
      reload,
    }),
    [slug, patientId, data, marks, events, prices, billing, products, markProducts, packages, plans, write, reload]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
