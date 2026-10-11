"use client";

/*
  One dental chart for the whole patient file.

  The chart used to keep its entries in the tab's own state, started from the
  page's first render. Leaving the tab unmounted it, and coming back started
  again from that first render — so everything recorded since had gone from
  the screen until a reload, though it was saved all along. With the chart in
  two tabs, the Treatment tab and the Dental chart, that would happen at every
  switch.

  So the chart lives here, above the tabs, for as long as the file is open:
  its entries and their history, the cases they are filed under, the steps of
  each treatment, the visits, and the patient's medical history. The tabs draw
  from it and write through it. It reads the chart again only when the copy it
  holds may be old:
  - the page was brought back by the browser's Back button, which restores a
    snapshot of the page without asking the server;
  - a colleague changed this patient's chart on another screen — the
    assistant's tablet beside the dentist's.
  Never for its own writes: the database announces those too, and the tap has
  already been drawn.

  Kept free of the catalog and the drawings, so the file that mounts it does
  not ship them to clinics that have no chart.
*/

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useRealtimeRefresh, type RealtimeEvent } from "@/lib/use-realtime";
import type { DentalChartData, FavoriteRow } from "@/lib/charts/dental/db";
import type { Mark, MarkEvent, Person } from "@/lib/charts/dental/state";
import type { Treatment } from "@/lib/charts/dental/catalog";
import type { StepRecord } from "@/lib/charts/dental/protocols";
import type { Booking, TreatmentCase, Visit } from "@/lib/charts/dental/treatment";
import type { MedicalHistory } from "@/lib/medical-history";
import type { PriceRow } from "@/lib/charts/dental/pricing";
import type { Billed } from "@/lib/charts/dental/billing-server";

/** A file of the patient's, as the chart reads it: x-rays and photos, and the teeth each shows. */
export type ChartFile = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
  created_at: string;
  teeth?: string[];
};

/** What the patient page hands the chart: the saved chart, and who is charting. */
export type DentalTabData = {
  me: Person;
  /** The signed-in member, so "performed by" starts on the doctor at the chair. */
  myMemberId: string | null;
  doctors: Person[];
  /** May this member record on the chart (`patients.charts`)? */
  canWrite: boolean;
  /** May this member book visits (`calendar`)? */
  canBook: boolean;
  /** May this member see what was billed and bill it (`invoices`)? */
  canBill: boolean;
  /** May this member set the clinic's prices (`settings.services`)? */
  canPrice?: boolean;
  /** The clinic's currency, for prices on the plan. */
  currency: string;
  chart: DentalChartData;
  clinicName: string;
  /** May this member send the patient a picture on WhatsApp, and has the patient a number? */
  canMessage: boolean;
};

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export type DentalStore = {
  slug: string;
  patientId: string;
  me: Person;
  myMemberId: string | null;
  doctors: Person[];
  canWrite: boolean;
  canBook: boolean;
  canBill: boolean;
  canPrice: boolean;
  currency: string;

  marks: Mark[];
  setMarks: Setter<Mark[]>;
  events: MarkEvent[];
  setEvents: Setter<MarkEvent[]>;
  custom: Treatment[];
  setCustom: Setter<Treatment[]>;
  favorites: FavoriteRow[];
  setFavorites: Setter<FavoriteRow[]>;
  files: ChartFile[];
  setFiles: Setter<ChartFile[]>;
  /** Which teeth each file is pinned to, by file id. */
  pins: Record<string, string[]>;
  setPins: Setter<Record<string, string[]>>;
  cases: TreatmentCase[];
  setCases: Setter<TreatmentCase[]>;
  steps: StepRecord[];
  setSteps: Setter<StepRecord[]>;
  visits: Visit[];
  bookings: Booking[];
  medical: MedicalHistory;
  setMedical: Setter<MedicalHistory>;
  /** The clinic's dental prices. */
  prices: PriceRow[];
  /** What has been billed of each treatment — empty for a member who may not see invoices. */
  billing: Billed[];
  /** From when chart work waits to be billed. */
  billingSince: string | null;

  /** The case new work is filed under: the one open in the Treatment tab, else the latest still open. */
  activeCaseId: string | null;
  setActiveCaseId: (id: string | null) => void;
  /** The treatment whose steps are open, in either tab. */
  openItem: string | null;
  setOpenItem: (id: string | null) => void;
  /** The emergency sheet, open: on a treatment under way, on a tooth, or on neither. */
  emergency: { markId?: string; site?: string } | null;
  setEmergency: (e: { markId?: string; site?: string } | null) => void;

  /**
   * Send a write through the store. While it is in flight a re-read waits —
   * a copy read mid-write could take back a tap already drawn — and the rows
   * it names are this screen's own, so their echo from the database is not
   * read as a colleague's change.
   */
  write<T>(ids: string[], p: Promise<T>): Promise<T>;
  /** Read the chart again now. */
  reload(): Promise<void>;
};

const Ctx = createContext<DentalStore | null>(null);

export function useDentalStore(): DentalStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useDentalStore outside DentalProvider");
  return s;
}

/** The store when there is one — a file without the chart has none. */
export function useOptionalDentalStore(): DentalStore | null {
  return useContext(Ctx);
}

/** An echo arrives within moments of the write; after this, a change to the same row is somebody else's. */
const MINE_FOR_MS = 15_000;
/** A page older than this when it mounts was restored from history, not freshly rendered. */
const STALE_AFTER_MS = 30_000;
/** The tables whose rows are this patient's chart. Each announces the patient it belongs to. */
const TABLES = ["chart_marks", "chart_mark_steps", "treatment_cases", "appointment_items"];
/** And for a member who sees billing: an invoice raised or voided at the desk changes what is billed. */
const TABLES_WITH_BILLING = [...TABLES, "invoices"];

const pinsOf = (files: ChartFile[]) => Object.fromEntries(files.map((f) => [f.id, f.teeth ?? []]));
/** The latest case still open: where new work goes when nobody chose. */
const latestOpen = (cases: TreatmentCase[]) => cases.find((c) => c.status === "open")?.id ?? null;

export function DentalProvider({
  slug,
  patientId,
  data,
  files: initialFiles,
  renderedAt,
  children,
}: {
  slug: string;
  patientId: string;
  data: DentalTabData;
  files: ChartFile[];
  /** When the server rendered the page, in epoch milliseconds. */
  renderedAt: number;
  children: React.ReactNode;
}) {
  const chart = data.chart;
  const [marks, setMarks] = useState<Mark[]>(chart.marks);
  const [events, setEvents] = useState<MarkEvent[]>(chart.events);
  const [custom, setCustom] = useState<Treatment[]>(chart.custom);
  const [favorites, setFavorites] = useState<FavoriteRow[]>(chart.favorites);
  const [files, setFiles] = useState<ChartFile[]>(initialFiles);
  const [pins, setPins] = useState<Record<string, string[]>>(() => pinsOf(initialFiles));
  const [cases, setCases] = useState<TreatmentCase[]>(chart.cases);
  const [steps, setSteps] = useState<StepRecord[]>(chart.steps);
  const [visits, setVisits] = useState<Visit[]>(chart.visits);
  const [bookings, setBookings] = useState<Booking[]>(chart.bookings);
  const [medical, setMedical] = useState<MedicalHistory>(chart.medical);
  const [prices, setPrices] = useState<PriceRow[]>(chart.prices);
  const [billing, setBilling] = useState<Billed[]>(chart.billing);
  const [chosenCase, setChosenCase] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [emergency, setEmergency] = useState<{ markId?: string; site?: string } | null>(null);

  // A case chosen in the Treatment tab while it exists; otherwise the latest open one.
  const activeCaseId = chosenCase && cases.some((c) => c.id === chosenCase) ? chosenCase : latestOpen(cases);

  const sync = useRef({
    inflight: 0,
    /** Bumped by every write, so a read that started before one is known to be out of date. */
    writes: 0,
    /** A re-read was asked for while writes were in flight. */
    owed: false,
    mine: new Map<string, number>(),
  });
  // Decided once, on mount: a page restored from history reads the chart again as soon as it can.
  const [staleOnMount] = useState(() => Date.now() - renderedAt > STALE_AFTER_MS);

  const reload = useCallback(async () => {
    const s = sync.current;
    if (s.inflight > 0) {
      s.owed = true;
      return;
    }
    const startedAt = s.writes;
    const res = await fetch(`/api/c/${slug}/patients/${patientId}/dental`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { ok?: boolean; chart?: DentalChartData; files?: ChartFile[] } | null;
    if (!body?.ok || !body.chart || !body.files) return;
    // A write began while this was on its way: what came back may not include it.
    if (s.writes !== startedAt || s.inflight > 0) {
      s.owed = true;
      return;
    }
    const c = body.chart;
    setMarks(c.marks);
    setEvents(c.events);
    setCustom(c.custom);
    setFavorites(c.favorites);
    setCases(c.cases);
    setSteps(c.steps);
    setVisits(c.visits);
    setBookings(c.bookings);
    setMedical(c.medical);
    setPrices(c.prices);
    setBilling(c.billing);
    setFiles(body.files);
    setPins(pinsOf(body.files));
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
  useRealtimeRefresh(slug, data.canBill ? TABLES_WITH_BILLING : TABLES, reload, isOthers, { syncOnOpen: staleOnMount });

  const value = useMemo<DentalStore>(
    () => ({
      slug,
      patientId,
      me: data.me,
      myMemberId: data.myMemberId,
      doctors: data.doctors,
      canWrite: data.canWrite,
      canBook: data.canBook,
      canBill: data.canBill,
      canPrice: !!data.canPrice,
      currency: data.currency,
      marks,
      setMarks,
      events,
      setEvents,
      custom,
      setCustom,
      favorites,
      setFavorites,
      files,
      setFiles,
      pins,
      setPins,
      cases,
      setCases,
      steps,
      setSteps,
      visits,
      bookings,
      medical,
      setMedical,
      prices,
      billing,
      billingSince: chart.billingSince,
      activeCaseId,
      setActiveCaseId: setChosenCase,
      openItem,
      setOpenItem,
      emergency,
      setEmergency,
      write,
      reload,
    }),
    [slug, patientId, data, marks, events, custom, favorites, files, pins, cases, steps, visits, bookings, medical, prices, billing, chart.billingSince, activeCaseId, openItem, emergency, write, reload]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
