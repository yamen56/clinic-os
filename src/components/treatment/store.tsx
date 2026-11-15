"use client";

/*
  One treatment record for the whole patient file.

  Held above the tabs, like the charts' stores, so the Overview's card, the
  Appointments tab, the Notes tab and the Invoices tab read the same record,
  and a line tapped on one is there on the others. It reads the record again
  only when the copy it holds may be old: a page brought back by the Back
  button, or a colleague writing on this patient from another screen. Never
  for its own writes — the tap has already been drawn.

  The sheet that edits a visit's record is opened from several places (the
  visit banner, the card, an appointment's row), so which visit it is open on
  lives here too, and one sheet serves them all.
*/

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useRealtimeRefresh, type RealtimeEvent } from "@/lib/use-realtime";
import type { Billed } from "@/lib/charts/dental/billing-server";
import type { GeneralMark, ServiceOption, TreatmentData, VisitRecord } from "@/lib/treatment/db";
import type { FeedItem } from "@/lib/note-feed";

type Person = { id: string; name: string };

/** An id made in the browser, so what is drawn and what is stored are the same row from the start. */
export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));

/** A JSON call to the record's routes; throws with the server's error code. */
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

/** A visit as the record needs it: when, with whom, and what it was booked for. */
export type TreatmentVisit = {
  id: string;
  starts_at: string;
  status: string;
  service_name: string | null;
  service_name_ar: string | null;
  doctor_name: string | null;
  doctor_member_id?: string | null;
  /** Every service it was booked for, the first one first (0106). */
  service_ids?: string[];
};

/** A file of the patient's, as much of it as a visit's record shows. */
export type VisitFile = { id: string; file_name: string; mime_type: string; kind: string; created_at: string; appointment_id?: string | null };

/** A prescription, as much of it as a visit's record shows. */
export type VisitRx = { id: string; number: number; created_at: string; items: { name?: string }[]; appointment_id: string | null };

/** What the patient page hands the record: what is saved, and who is writing. */
export type TreatmentTabData = {
  me: Person;
  /** The signed-in member, so "done by" starts on the doctor at the chair. */
  myMemberId: string | null;
  doctors: Person[];
  /** May this member record (`patients.charts`)? */
  canWrite: boolean;
  /** May this member see what was billed and bill it (`invoices`)? */
  canBill: boolean;
  currency: string;
  treatment: TreatmentData;
};

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export type TreatmentStore = Omit<TreatmentTabData, "treatment"> & {
  slug: string;
  patientId: string;
  tz: string;
  visits: TreatmentVisit[];
  /** What was said when each visit was booked, for the sheet to show beside the complaint. */
  feed: FeedItem[];
  records: VisitRecord[];
  setRecords: Setter<VisitRecord[]>;
  marks: GeneralMark[];
  setMarks: Setter<GeneralMark[]>;
  billing: Billed[];
  services: ServiceOption[];
  /** The patient's prescriptions and files; a visit's record shows the ones written or added at it. */
  prescriptions: VisitRx[];
  files: VisitFile[];
  /** A file this screen just added: shown at once, before the page hears of it. */
  addFile(f: VisitFile): void;
  /** Write a prescription for a visit, starting from its diagnosis. Absent for a member who may not prescribe. */
  prescribe?: (appointmentId: string | null, diagnosis: string) => void;
  /** The visit the sheet is open on: an appointment, or `null` inside for a day with none. Undefined: closed. */
  sheet: { appointmentId: string | null } | undefined;
  openSheet(appointmentId: string | null): void;
  closeSheet(): void;
  /** The record the reader left for a chart, so the chart's tab can offer the way back to it. */
  returnTo: { appointmentId: string | null } | null;
  setReturnTo(v: { appointmentId: string | null } | null): void;
  /** Show another tab of the file — a chart's work opens on its chart. */
  goTab(key: string): void;
  /** Send a write through the store: a re-read waits for it, and its echo is not taken for a colleague's change. */
  write<T>(ids: string[], p: Promise<T>): Promise<T>;
  /** A row this screen is saving by another road (the record's autosave): its echo is ours too. */
  mine(id: string): void;
  reload(): Promise<void>;
};

const Ctx = createContext<TreatmentStore | null>(null);

export function useTreatmentStore(): TreatmentStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useTreatmentStore outside TreatmentProvider");
  return s;
}

/** The store when there is one. */
export function useOptionalTreatmentStore(): TreatmentStore | null {
  return useContext(Ctx);
}

/** An echo arrives within moments of the write; after this, a change to the same row is somebody else's. */
const MINE_FOR_MS = 15_000;
/** A page older than this when it mounts was restored from history, not freshly rendered. */
const STALE_AFTER_MS = 30_000;

export function TreatmentProvider({
  slug,
  patientId,
  tz,
  data,
  visits,
  feed,
  prescriptions,
  files,
  sheet,
  onSheet,
  onPrescribe,
  renderedAt,
  onTab,
  children,
}: {
  slug: string;
  patientId: string;
  tz: string;
  data: TreatmentTabData;
  visits: TreatmentVisit[];
  feed: FeedItem[];
  prescriptions: VisitRx[];
  files: VisitFile[];
  /** Which visit the sheet is open on — held by the file, which opens the prescription over it and comes back. */
  sheet: { appointmentId: string | null } | undefined;
  onSheet: (v: { appointmentId: string | null } | undefined) => void;
  onPrescribe?: (appointmentId: string | null, diagnosis: string) => void;
  renderedAt: number;
  onTab: (key: string) => void;
  children: React.ReactNode;
}) {
  const [records, setRecords] = useState<VisitRecord[]>(data.treatment.records);
  const [marks, setMarks] = useState<GeneralMark[]>(data.treatment.marks);
  const [billing, setBilling] = useState<Billed[]>(data.treatment.billing);
  const [services, setServices] = useState<ServiceOption[]>(data.treatment.services);
  const [added, setAdded] = useState<VisitFile[]>([]);
  const [returnTo, setReturnTo] = useState<{ appointmentId: string | null } | null>(null);
  const setSheet = useRef(onSheet);
  setSheet.current = onSheet;
  const allFiles = useMemo(() => {
    const known = new Set(files.map((f) => f.id));
    return [...added.filter((f) => !known.has(f.id)), ...files];
  }, [files, added]);
  const addFile = useCallback((f: VisitFile) => setAdded((prev) => [f, ...prev]), []);
  const sync = useRef({ inflight: 0, writes: 0, owed: false, mine: new Map<string, number>() });
  const [staleOnMount] = useState(() => Date.now() - renderedAt > STALE_AFTER_MS);
  const tab = useRef(onTab);
  tab.current = onTab;

  const reload = useCallback(async () => {
    const s = sync.current;
    if (s.inflight > 0) {
      s.owed = true;
      return;
    }
    const startedAt = s.writes;
    const res = await fetch(`/api/c/${slug}/patients/${patientId}/treatment`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as { ok?: boolean; treatment?: TreatmentData } | null;
    if (!body?.ok || !body.treatment) return;
    // A write began while this was on its way: what came back may not include it.
    if (s.writes !== startedAt || s.inflight > 0) {
      s.owed = true;
      return;
    }
    setRecords(body.treatment.records);
    setMarks(body.treatment.marks);
    setBilling(body.treatment.billing);
    setServices(body.treatment.services);
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
  useRealtimeRefresh(slug, data.canBill ? ["chart_marks", "visit_records", "invoices"] : ["chart_marks", "visit_records"], reload, isOthers, {
    syncOnOpen: staleOnMount,
  });

  const openSheet = useCallback((appointmentId: string | null) => {
    setReturnTo(null);
    setSheet.current({ appointmentId });
  }, []);
  const closeSheet = useCallback(() => setSheet.current(undefined), []);
  const goTab = useCallback((key: string) => tab.current(key), []);
  const mine = useCallback((id: string) => void sync.current.mine.set(id, Date.now()), []);

  const value = useMemo<TreatmentStore>(
    () => ({
      slug,
      patientId,
      tz,
      visits,
      feed,
      me: data.me,
      myMemberId: data.myMemberId,
      doctors: data.doctors,
      canWrite: data.canWrite,
      canBill: data.canBill,
      currency: data.currency,
      records,
      setRecords,
      marks,
      setMarks,
      billing,
      services,
      prescriptions,
      files: allFiles,
      addFile,
      prescribe: onPrescribe,
      sheet,
      openSheet,
      closeSheet,
      returnTo,
      setReturnTo,
      goTab,
      write,
      mine,
      reload,
    }),
    [slug, patientId, tz, visits, feed, data, records, marks, billing, services, prescriptions, allFiles, addFile, onPrescribe, sheet, openSheet, closeSheet, returnTo, goTab, write, mine, reload]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
