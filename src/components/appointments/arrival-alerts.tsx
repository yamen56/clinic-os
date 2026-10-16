"use client";

import { useCallback, useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import type { LiveNotif } from "@/components/live-notifications";

type Arrival = {
  id: string;
  arrived_at: string;
  patient_name: string;
  room_name: string | null;
  room_name_ar: string | null;
};

/** A claim older than this is housekeeping, not news. */
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
/** On opening the app, an arrival this recent still deserves the chime. */
const FRESH_ON_LOAD_MS = 60 * 1000;
const PREFIX = "clinicti.arrived.";

/**
 * The doctor hears their patient arrive, on whatever screen they are on.
 *
 * Mounted by the shell for doctors only. Whenever an appointment changes in
 * the clinic it re-reads the doctor's own waiting room (a few rows, at most
 * once a second — useRealtimeRefresh) and chimes for anybody new in it.
 *
 * Three things keep it from crying wolf:
 *  - the first read only remembers who is already waiting, so opening the app
 *    does not chime for the whole morning — except for an arrival in the last
 *    minute, which the doctor may have missed while the page loaded;
 *  - each arrival is claimed in localStorage, so a doctor with the app open in
 *    three tabs hears it once;
 *  - the claim is per arrival time, so a mistaken "arrived" that was undone
 *    and pressed again chimes again, and a reload does not.
 */
export function ArrivalAlerts({ slug, push }: { slug: string; push: (n: LiveNotif) => void }) {
  const { t, locale } = useI18n();
  const known = useRef<Set<string> | null>(null);
  const words = useRef({ t, locale });
  words.current = { t, locale };

  const check = useCallback(async () => {
    const res = await fetch(`/api/c/${slug}/appointments/arrivals`, { cache: "no-store" });
    if (!res.ok) return;
    const { arrivals, serverNow } = (await res.json()) as { arrivals: Arrival[]; serverNow: string };
    const first = known.current === null;
    const prev = known.current ?? new Set<string>();
    const now = Date.parse(serverNow);
    for (const a of arrivals) {
      const key = `${a.id}@${a.arrived_at}`;
      if (prev.has(key)) continue;
      if (first && now - Date.parse(a.arrived_at) > FRESH_ON_LOAD_MS) continue;
      if (!claim(key)) continue;
      const { t: tt, locale: lc } = words.current;
      const room = (lc === "ar" && a.room_name_ar) || a.room_name;
      push({
        id: `local:arrived:${key}`,
        kind: "patient_arrived",
        title: tt.flow.arrivedToast.replace("{name}", a.patient_name),
        body: room ? tt.flow.arrivedBodyRoom.replace("{room}", room) : tt.flow.arrivedBody,
        url: `/c/${slug}/calendar?tab=today`,
        created_at: a.arrived_at,
        cursor: a.arrived_at,
      });
    }
    known.current = new Set(arrivals.map((a) => `${a.id}@${a.arrived_at}`));
  }, [slug, push]);

  useEffect(() => {
    prune();
    void check();
  }, [check]);

  useRealtimeRefresh(slug, ["appointments"], check);
  return null;
}

/** True for the first tab to see this arrival. */
function claim(key: string): boolean {
  try {
    const k = PREFIX + key;
    if (localStorage.getItem(k)) return false;
    localStorage.setItem(k, String(Date.now()));
  } catch {
    // Storage blocked (private mode): every tab chimes, which beats none.
  }
  return true;
}

function prune() {
  try {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX) && Number(localStorage.getItem(k)) < cutoff) localStorage.removeItem(k);
    }
  } catch {}
}
