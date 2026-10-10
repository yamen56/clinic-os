"use client";

/*
  One dental chart for the whole patient file.

  The chart used to keep its entries in the tab's own state, started from the
  page's first render. Leaving the tab unmounted it, and coming back started
  again from that first render — so everything recorded since had gone from
  the screen until a reload, though it was saved all along. With the chart in
  two tabs, the Treatment tab and the Dental chart, that would happen at every
  switch.

  So the chart lives here, above the tabs, for as long as the file is open.
  The tabs draw from it and write through it. It reads the chart again only
  when the copy it holds may be old:
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
import type { Mark, MarkEvent } from "@/lib/charts/dental/state";
import type { Treatment } from "@/lib/charts/dental/catalog";

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

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export type DentalStore = {
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

const pinsOf = (files: ChartFile[]) => Object.fromEntries(files.map((f) => [f.id, f.teeth ?? []]));

export function DentalProvider({
  slug,
  patientId,
  chart,
  files: initialFiles,
  renderedAt,
  children,
}: {
  slug: string;
  patientId: string;
  chart: DentalChartData;
  files: ChartFile[];
  /** When the server rendered the page, in epoch milliseconds. */
  renderedAt: number;
  children: React.ReactNode;
}) {
  const [marks, setMarks] = useState<Mark[]>(chart.marks);
  const [events, setEvents] = useState<MarkEvent[]>(chart.events);
  const [custom, setCustom] = useState<Treatment[]>(chart.custom);
  const [favorites, setFavorites] = useState<FavoriteRow[]>(chart.favorites);
  const [files, setFiles] = useState<ChartFile[]>(initialFiles);
  const [pins, setPins] = useState<Record<string, string[]>>(() => pinsOf(initialFiles));

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
    setMarks(body.chart.marks);
    setEvents(body.chart.events);
    setCustom(body.chart.custom);
    setFavorites(body.chart.favorites);
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
  useRealtimeRefresh(slug, ["chart_marks"], reload, isOthers, { syncOnOpen: staleOnMount });

  const value = useMemo<DentalStore>(
    () => ({ marks, setMarks, events, setEvents, custom, setCustom, favorites, setFavorites, files, setFiles, pins, setPins, write, reload }),
    [marks, events, custom, favorites, files, pins, write, reload]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
