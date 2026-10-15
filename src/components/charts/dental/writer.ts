"use client";

/*
  Every write behind the chart, in one place.

  Both tabs, the plan, the procedure card and the emergency sheet record
  through here, so each change is drawn the moment it is made, stored behind
  it, and put back exactly as it was if the server says no. The browser
  chooses the ids, so what is drawn and what is stored are the same rows from
  the start, and the server's answer only ever replaces them.
*/

import { useCallback } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import type { Mark, MarkEvent, Person } from "@/lib/charts/dental/state";
import { leadIdOf } from "@/lib/charts/dental/full-arch";
import { EMERGENCY_STEP, type StepData, type StepRecord } from "@/lib/charts/dental/protocols";
import type { MedicalHistory } from "@/lib/medical-history";
import { priceFrom, unitOf, type PriceUnit } from "@/lib/charts/dental/pricing";
import { useDentalStore } from "./store";

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));

/** A JSON call to the chart's routes; throws with the server's error code. */
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

export type FreshMark = Mark & { eventId: string };

type StepAnswer = { marks: Mark[]; steps: StepRecord[]; events: MarkEvent[]; completed?: boolean };

export function useChartWriter() {
  const s = useDentalStore();
  const { t } = useI18n();
  const { toast } = useToast();
  const { slug, patientId, me, marks, setMarks, setEvents, setSteps, setMedical, write } = s;
  const base = `/api/c/${slug}/patients/${patientId}`;
  const failed = useCallback(() => toast(t.dental.saveFailed, "error"), [toast, t.dental.saveFailed]);

  const removeLocal = useCallback(
    (ids: Set<string>) => {
      setMarks((prev) => prev.filter((m) => !ids.has(m.id)));
      setEvents((prev) => prev.filter((e) => !ids.has(e.markId)));
    },
    [setMarks, setEvents]
  );

  /** Put the server's rows in place of the ones drawn ahead of it. */
  const settle = useCallback(
    (rows: Mark[], evs: MarkEvent[]) => {
      const byId = new Map(rows.map((m) => [m.id, m]));
      setMarks((prev) => prev.map((m) => byId.get(m.id) ?? m));
      const evIds = new Set(evs.map((e) => e.id));
      setEvents((prev) => [...prev.filter((e) => !evIds.has(e.id)), ...evs]);
    },
    [setMarks, setEvents]
  );

  /** A step route's answer: the treatment and the teeth it changed, all of its steps, the lines written. */
  const applySteps = useCallback(
    (markId: string, r: StepAnswer) => {
      settle(r.marks, r.events);
      setSteps((prev) => [...prev.filter((x) => x.markId !== markId), ...r.steps]);
    },
    [settle, setSteps]
  );

  /** New entries: drawn now, stored behind them, taken off again if refused. True when stored. */
  const postMarks = useCallback(
    async (fresh: FreshMark[]): Promise<boolean> => {
      const now = fresh[0]?.createdAt ?? new Date().toISOString();
      setMarks((prev) => [...prev, ...fresh.map(({ eventId: _e, ...m }) => m)]);
      setEvents((prev) => [...prev, ...fresh.map((m) => ({ id: m.eventId, markId: m.id, action: "created" as const, at: now, by: me }))]);
      try {
        const r = await write(
          fresh.map((m) => m.id),
          call<{ marks: Mark[]; events: MarkEvent[] }>(`${base}/dental/marks`, "POST", {
            marks: fresh.map((m) => ({
              id: m.id,
              eventId: m.eventId,
              site: m.site,
              surfaces: m.surfaces,
              treatmentKey: m.treatmentKey,
              detail: m.detail,
              status: m.status,
              groupId: m.groupId ?? null,
              role: m.role ?? null,
              performedBy: m.performedBy?.id ?? null,
              emergency: m.emergency,
              redoOf: m.redoOf ?? null,
              note: m.note,
            })),
          })
        );
        settle(r.marks, r.events);
        return true;
      } catch {
        removeLocal(new Set(fresh.map((m) => m.id)));
        failed();
        return false;
      }
    },
    [base, me, setMarks, setEvents, write, settle, removeLocal, failed]
  );

  /*
    A change to an entry: drawn now, stored behind it, and put back exactly as
    it was if the server says no. A group's lead takes its members with it
    when it is done or voided — the server does the same.
  */
  const change = useCallback(
    (m: Mark, next: Mark, body: Record<string, unknown>, action?: MarkEvent["action"], reason?: string) => {
      const eventId = action ? newId() : null;
      const op = body.op;
      const lead = op === "done" || op === "void";
      const kids = lead && m.groupId ? leadFollowers(m, marks).filter((x) => !x.voidedAt && (op === "void" || x.status === "planned")) : [];
      const kidIds = new Set(kids.map((x) => x.id));
      const kidNext = (x: Mark): Mark =>
        op === "done" ? { ...x, status: "done", doneAt: next.doneAt } : { ...x, voidedAt: next.voidedAt, voidedBy: next.voidedBy, voidReason: next.voidReason };
      setMarks((prev) => prev.map((x) => (x.id === m.id ? next : kidIds.has(x.id) ? kidNext(x) : x)));
      if (action && eventId) setEvents((prev) => [...prev, { id: eventId, markId: m.id, action, at: new Date().toISOString(), by: me, reason }]);
      return write(
        [m.id, ...kidIds],
        call<{ mark: Mark; event: MarkEvent | null; also?: Mark[]; alsoEvents?: MarkEvent[] }>(`${base}/dental/marks/${m.id}`, "PATCH", eventId ? { ...body, eventId } : body)
      )
        .then((r) => {
          settle([r.mark, ...(r.also ?? [])], [...(r.event ? [r.event] : []), ...(r.alsoEvents ?? [])]);
          return true;
        })
        .catch(() => {
          setMarks((prev) => prev.map((x) => (x.id === m.id ? m : kids.find((k) => k.id === x.id) ?? x)));
          if (eventId) setEvents((prev) => prev.filter((e) => e.id !== eventId));
          failed();
          return false;
        });
    },
    [base, marks, me, setMarks, setEvents, write, settle, failed]
  );

  /** Take entries back: a mis-tap, within two minutes, by whoever made it. Returns the ids the server refused. */
  const unrecord = useCallback(
    async (ids: string[]): Promise<string[]> => {
      const gone = marks.filter((m) => ids.includes(m.id));
      removeLocal(new Set(ids));
      const refused: string[] = [];
      for (const id of ids) await write([id], call(`${base}/dental/marks/${id}`, "DELETE")).catch(() => refused.push(id));
      if (refused.length) setMarks((prev) => [...prev, ...gone.filter((m) => refused.includes(m.id))]);
      return refused;
    },
    [base, marks, removeLocal, write, setMarks]
  );

  /** A step done: the treatment moves on, and is finished when it was the last one it needed. */
  const recordStep = useCallback(
    async (mark: Mark, step: string, data: StepData, opts: { note?: string; performer?: Person | null } = {}): Promise<boolean> => {
      const now = new Date().toISOString();
      const rec: StepRecord = {
        id: newId(),
        markId: mark.id,
        step,
        data,
        note: opts.note ?? "",
        performedBy: opts.performer ?? null,
        recordedBy: me,
        appointmentId: null,
        doneAt: now,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
      };
      const eventId = newId();
      setSteps((prev) => [...prev, rec]);
      if (step !== EMERGENCY_STEP && !mark.startedAt) setMarks((prev) => prev.map((x) => (x.id === mark.id ? { ...x, startedAt: now } : x)));
      setEvents((prev) => [...prev, { id: eventId, markId: mark.id, action: "step", at: now, by: me, reason: step }]);
      try {
        const r = await write(
          [mark.id],
          call<StepAnswer>(`${base}/dental/marks/${mark.id}/steps`, "POST", {
            id: rec.id,
            eventId,
            step,
            data,
            note: rec.note,
            performedBy: opts.performer?.id ?? null,
          })
        );
        applySteps(mark.id, r);
        return true;
      } catch {
        setSteps((prev) => prev.filter((x) => x.id !== rec.id));
        setMarks((prev) => prev.map((x) => (x.id === mark.id ? { ...x, startedAt: mark.startedAt } : x)));
        setEvents((prev) => prev.filter((e) => e.id !== eventId));
        failed();
        return false;
      }
    },
    [base, me, setSteps, setMarks, setEvents, write, applySteps, failed]
  );

  /** A step taken back: voided with a reason, or — within two minutes, by whoever recorded it — undone. */
  const withdrawStep = useCallback(
    async (step: StepRecord, how: { undo: true } | { reason?: string }): Promise<boolean> => {
      const before = step;
      if ("undo" in how) setSteps((prev) => prev.filter((x) => x.id !== step.id));
      else setSteps((prev) => prev.map((x) => (x.id === step.id ? { ...x, voidedAt: new Date().toISOString(), voidedBy: me, voidReason: how.reason ?? null } : x)));
      try {
        const r = await write(
          [step.markId],
          "undo" in how
            ? call<StepAnswer>(`${base}/dental/steps/${step.id}`, "DELETE")
            : call<StepAnswer>(`${base}/dental/steps/${step.id}`, "PATCH", { op: "void", eventId: newId(), ...(how.reason ? { reason: how.reason } : {}) })
        );
        applySteps(step.markId, r);
        return true;
      } catch {
        setSteps((prev) => [...prev.filter((x) => x.id !== step.id), before]);
        failed();
        return false;
      }
    },
    [base, me, setSteps, write, applySteps, failed]
  );

  /** A step's data corrected: a canal re-measured, a length typed wrong. */
  const editStep = useCallback(
    async (step: StepRecord, data: StepData): Promise<boolean> => {
      setSteps((prev) => prev.map((x) => (x.id === step.id ? { ...x, data } : x)));
      try {
        const r = await write([step.markId], call<StepAnswer>(`${base}/dental/steps/${step.id}`, "PATCH", { op: "data", data }));
        applySteps(step.markId, r);
        return true;
      } catch {
        setSteps((prev) => prev.map((x) => (x.id === step.id ? step : x)));
        failed();
        return false;
      }
    },
    [base, setSteps, write, applySteps, failed]
  );

  /** The patient's medical history, saved whole — it is one short form. */
  const saveMedical = useCallback(
    async (h: MedicalHistory): Promise<boolean> => {
      const before = s.medical;
      setMedical({ ...h, updatedAt: new Date().toISOString(), updatedBy: me.name });
      try {
        const res = await write(
          [],
          fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch: { medical_history: h } }) })
        );
        if (!res.ok) throw new Error(`http_${res.status}`);
        return true;
      } catch {
        setMedical(before);
        failed();
        return false;
      }
    },
    [base, me.name, s.medical, setMedical, write, failed]
  );

  /*
    How this patient pays for a treatment: the whole of it, or each visit — at
    the list's price for that. Shown at once; put back if the server refuses
    (it does once any of it is billed).
  */
  const chargeBy = useCallback(
    async (m: Mark, unit: PriceUnit): Promise<boolean> => {
      const row = priceFrom(s.prices, m.treatmentKey, m.detail, unit);
      if (!row) return false;
      setMarks((prev) => prev.map((x) => (x.id === m.id ? { ...x, fee: row.price, serviceId: row.serviceId, feeManual: false } : x)));
      try {
        const r = await write([m.id], call<{ mark: Mark }>(`${base}/dental/marks/${m.id}/charge`, "POST", { unit }));
        settle([r.mark], []);
        return true;
      } catch (e) {
        setMarks((prev) => prev.map((x) => (x.id === m.id ? m : x)));
        toast((e as Error).message === "billed" ? t.dental.price.billedLocked : t.dental.price.failed, "error");
        return false;
      }
    },
    [s.prices, base, setMarks, write, settle, toast, t.dental.price]
  );

  /*
    This patient's price for a treatment, set by hand — or, with null, back to
    the list's. Shown at once, put back if the server refuses (it does once
    any of it is billed). The list itself is not touched.
  */
  const setFee = useCallback(
    async (m: Mark, fee: number | null): Promise<boolean> => {
      const list = fee === null ? priceFrom(s.prices, m.treatmentKey, m.detail, unitOf(m, s.prices)) : null;
      setMarks((prev) => prev.map((x) => (x.id === m.id ? { ...x, fee: fee ?? list?.price ?? null, feeManual: fee !== null } : x)));
      try {
        const r = await write([m.id], call<{ mark: Mark; event: MarkEvent }>(`${base}/dental/marks/${m.id}/fee`, "POST", { fee }));
        settle([r.mark], [r.event]);
        return true;
      } catch (e) {
        setMarks((prev) => prev.map((x) => (x.id === m.id ? m : x)));
        toast((e as Error).message === "billed" ? t.dental.price.editLocked : t.dental.price.failed, "error");
        return false;
      }
    },
    [s.prices, base, setMarks, write, settle, toast, t.dental.price]
  );

  return { postMarks, change, unrecord, settle, removeLocal, recordStep, withdrawStep, editStep, saveMedical, chargeBy, setFee };
}

/** The members a group's lead carries, found the same way the server finds them. */
function leadFollowers(m: Mark, marks: Mark[]): Mark[] {
  if (!m.groupId) return [];
  const members = marks.filter((x) => x.groupId === m.groupId);
  return leadIdOf(members) === m.id ? members.filter((x) => x.id !== m.id) : [];
}
