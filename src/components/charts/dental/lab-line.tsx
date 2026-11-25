"use client";

/*
  A treatment's lab work, where the treatment is: in its card.

  A crown, a bridge, a denture is made at a lab (Yamen, 2026-10-17). Send to
  lab says which of the clinic's labs — its own, or one outside — with the
  lab's price for it already in, a due date, and the shade from the
  preparation. The case then shows where it is: at the lab (late in red), back,
  or called off; its cost is what comes into the doctor's share. The doctor at
  the chair or the desk may do any of it. Like everything on the chart, a tap
  is drawn at once and put back if the server says no.

  A bridge or a full arch goes more than once (a dentist, 2026-11-25): for its
  framework, the porcelain, to be finished. In the treatment's steps each trip
  stands between the visits it stands between (LabStop), so the card reads in
  the order the work is done: impression, lab, framework try-in, lab, … It is
  one order at one price; only a remake is another.
*/

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, FlaskConical, Pencil } from "lucide-react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtMoney } from "@/lib/dates";
import type { Mark } from "@/lib/charts/dental/state";
import { PRICE_BY, variantName, variantOf } from "@/lib/charts/dental/pricing";
import { leadIdOf } from "@/lib/charts/dental/full-arch";
import {
  LAB_AFTER_STEP,
  LAB_TREATMENTS,
  LAB_TRIPS,
  PER_TOOTH,
  isOverdue,
  labCostFor,
  labPriceFor,
  nextAnchor,
  stagesFor,
  tripAnchors,
  tripsOf,
  type LabCase,
  type LabStage,
  type LabTrip,
} from "@/lib/charts/dental/labs";
import { detailOptions, isImplied, stepOf } from "@/lib/charts/dental/protocols";
import { isToothSite } from "@/lib/charts/dental/state";
import { useDentalStore } from "./store";
import { useChartWriter } from "./writer";
import { priceable } from "./price-line";

/** Is this step of the treatment recorded — or done as part of another one? */
function useStepDone(m: Mark): (step: string) => boolean {
  const store = useDentalStore();
  const own = store.steps.filter((s) => s.markId === m.id && !s.voidedAt);
  return (step) => {
    if (own.some((s) => s.step === step)) return true;
    const def = stepOf(m.treatmentKey, step);
    return !!def && isImplied(def, own);
  };
}

/** The teeth a bridge has; 1 for anything else. */
function unitsOf(m: Mark, marks: Mark[]): number {
  if (!PER_TOOTH.has(m.treatmentKey) || !m.groupId) return 1;
  return Math.max(1, marks.filter((x) => x.groupId === m.groupId && !x.voidedAt && isToothSite(x.site)).length);
}

/** May lab work be shown on this entry at all — and changed? */
function useLabWork(m: Mark) {
  const store = useDentalStore();
  // A bridge goes to the lab once, on its lead — the tooth its invoice line bills, so its cost reaches the share.
  const mates = m.groupId ? store.marks.filter((x) => x.groupId === m.groupId && !x.voidedAt) : [];
  const lead = !(mates.length > 1 && leadIdOf(mates) !== m.id);
  return {
    shown: priceable(m, store.marks) && lead,
    mayEdit: store.canWrite || store.canBill,
    cases: store.labCases.filter((c) => c.markId === m.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    active: store.labs.filter((l) => l.active),
    // Names for every case, an archived lab's too; only labs in use are offered to send to.
    nameOf: (id: string) => store.labs.find((l) => l.id === id)?.name ?? "—",
  };
}

export function LabLine({ m, tz }: { m: Mark; tz: string }) {
  const { t, locale } = useI18n();
  const L = t.dental.lab;
  const store = useDentalStore();
  const w = useChartWriter();
  const [open, setOpen] = useState(false);
  const { shown, mayEdit, cases, active, nameOf } = useLabWork(m);
  const stepDone = useStepDone(m);
  if (!shown) return null;
  const isLabWork = LAB_TREATMENTS.has(m.treatmentKey);
  // Nothing to say about lab work on a filling nobody sent anywhere.
  if (!cases.length && !isLabWork && !mayEdit) return null;
  const today = DateTime.now().setZone(tz).toISODate()!;
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  // The work is ready to go once its impression is taken.
  const after = LAB_AFTER_STEP[m.treatmentKey];
  const impressionTaken = !after || stepDone(after);
  const live = cases.some((c) => c.status !== "cancelled");

  return (
    <div className="grid gap-1.5" data-lab-line={m.id}>
      {cases.map((c) => (
        <CaseRow key={c.id} c={c} m={m} name={nameOf(c.labId)} today={today} fmt={fmt} mayEdit={mayEdit} onOp={(op) => w.labCaseOp(c, op)} />
      ))}
      {mayEdit && !open && (isLabWork || cases.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-[0.78125rem]">
          {active.length === 0 ? (
            <NoLabs />
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-semibold ${
                isLabWork && !live && impressionTaken ? "bg-brand-600 text-on-brand hover:bg-brand-hover" : "border border-line-strong text-ink-700 hover:bg-sunken"
              }`}
              data-lab-send={m.id}
            >
              <FlaskConical className="h-3.5 w-3.5" />
              {live ? L.sendAgain : L.send}
            </button>
          )}
        </div>
      )}
      {mayEdit && !open && !isLabWork && !cases.length && active.length > 0 && (
        <button type="button" onClick={() => setOpen(true)} className="justify-self-start text-[0.75rem] font-semibold text-ink-500 hover:text-ink-900 hover:underline" data-lab-add={m.id}>
          {L.add}
        </button>
      )}
      {open && <SendForm m={m} tz={tz} onClose={() => setOpen(false)} />}
    </div>
  );
}

function NoLabs() {
  const { t } = useI18n();
  const L = t.dental.lab;
  const store = useDentalStore();
  return (
    <>
      <span className="text-ink-500">{L.noLabs}</span>
      {store.canPrice && (
        <Link href={`/c/${store.slug}/settings/labs`} className="font-semibold text-brand-700 hover:underline">
          {L.setUp}
        </Link>
      )}
    </>
  );
}

/**
 * A trip to the lab, standing among the treatment's steps where it belongs:
 * after the impression, after a framework was tried in, after the porcelain
 * was. Shown once the work has got there; the first one always, so the doctor
 * sees that the lab comes next.
 */
export function LabStop({ m, tz, after }: { m: Mark; tz: string; after: string }) {
  const { t, locale } = useI18n();
  const L = t.dental.lab;
  const store = useDentalStore();
  const w = useChartWriter();
  const [sending, setSending] = useState(false);
  const { shown, mayEdit, cases, active, nameOf } = useLabWork(m);
  const stepDone = useStepDone(m);
  const plan = LAB_TRIPS[m.treatmentKey] ?? [];
  if (!shown || !plan.length) return null;
  const first = plan[0].after === after;
  const today = DateTime.now().setZone(tz).toISODate()!;
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  const live = [...cases].reverse().find((c) => c.status !== "cancelled") ?? null;
  const old = first ? cases.filter((c) => c.id !== live?.id) : [];
  const trips = live ? tripsOf(live) : [];
  const anchors = tripAnchors(m.treatmentKey, trips);
  const here = trips.map((x, i) => ({ trip: x, i })).filter(({ i }) => anchors[i] === after);
  const current = trips.length - 1;
  const goesAgain = !!live && nextAnchor(m.treatmentKey, live) === after;
  const ready = stepDone(after);
  // Not reached yet, and not the next one to reach: nothing to show.
  if (!first && !here.length && !goesAgain) return null;

  const where = (trip: LabTrip, i: number) => {
    if (i < current || trip.receivedAt) return L.backOn.replace("{date}", trip.receivedAt ? fmtDateOnly(trip.receivedAt.slice(0, 10), locale) : "");
    if (!live || live.status === "received") return L.back;
    if (isOverdue(live, today)) return L.late.replace("{date}", fmtDateOnly(live.dueOn!, locale));
    return trip.dueOn ? L.due.replace("{date}", fmtDateOnly(trip.dueOn, locale)) : L.atLab;
  };

  return (
    <li className="rounded-card border border-dashed border-line-strong bg-canvas px-3 py-2.5" data-lab-stop={after} data-lab-stop-state={here.some(({ i }) => i === current) ? live?.status : goesAgain ? "goes-again" : here.length ? "back" : "before"}>
      <div className="grid gap-2">
        {old.map((c) => (
          <CaseRow key={c.id} c={c} m={m} name={nameOf(c.labId)} today={today} fmt={fmt} mayEdit={mayEdit} onOp={(op) => w.labCaseOp(c, op)} />
        ))}
        {live &&
          here.map(({ trip, i }) => {
            const late = i === current && isOverdue(live, today);
            return (
              <div key={i} className="grid gap-1.5" data-lab-trip={trip.stage} data-lab-trip-state={i < current || live.status === "received" ? "received" : "sent"}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem]">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface text-ink-500 ring-1 ring-line">
                    <FlaskConical className="h-3.5 w-3.5" />
                  </span>
                  <span className="font-semibold text-ink-900">{nameOf(live.labId)}</span>
                  <span className="text-ink-700">{L.stages[trip.stage]}</span>
                  <span className={late ? "font-semibold text-danger" : "text-ink-500"}>{where(trip, i)}</span>
                  {i === 0 && (
                    <span className="font-semibold tnum text-ink-900" data-lab-cost={live.id}>
                      {fmt(live.cost)}
                    </span>
                  )}
                  {i === 0 && live.paid && <span className="rounded-full bg-sunken px-2 py-0.5 text-[length:max(11px,0.6875rem)] font-semibold text-ink-500">{L.paid}</span>}
                  {i === current && mayEdit && (
                    <span className="ms-auto flex flex-wrap gap-1.5 text-[0.78125rem]">
                      {live.status === "sent" ? (
                        <button type="button" onClick={() => void w.labCaseOp(live, { op: "received" })} className="h-8 rounded-full bg-brand-600 px-3 font-semibold text-on-brand hover:bg-brand-hover" data-lab-received={live.id}>
                          {L.received}
                        </button>
                      ) : (
                        <button type="button" onClick={() => void w.labCaseOp(live, { op: "sent" })} className="h-8 rounded-full px-2 font-semibold text-ink-500 hover:text-ink-900" data-lab-undo={live.id}>
                          {L.notBack}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {i === 0 && <CaseMore c={live} m={m} mayEdit={mayEdit} onOp={(op) => w.labCaseOp(live, op)} onRemake={active.length ? () => setSending(true) : undefined} />}
              </div>
            );
          })}
        {/* Nothing sent yet: the lab comes next. */}
        {first && !live && !sending && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[0.8125rem]">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface text-ink-500 ring-1 ring-line">
              <FlaskConical className="h-3.5 w-3.5" />
            </span>
            <span className="text-ink-500">{ready ? L.readyForLab : L.thenLab}</span>
            {mayEdit && (
              <span className="ms-auto text-[0.78125rem]">
                {active.length === 0 ? (
                  <NoLabs />
                ) : (
                  <button
                    type="button"
                    onClick={() => setSending(true)}
                    className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 font-semibold ${ready ? "bg-brand-600 text-on-brand hover:bg-brand-hover" : "border border-line-strong text-ink-700 hover:bg-sunken"}`}
                    data-lab-send={m.id}
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                    {L.send}
                  </button>
                )}
              </span>
            )}
          </div>
        )}
        {sending && <SendForm m={m} tz={tz} onClose={() => setSending(false)} />}
        {/* Tried in, and not finished: back to the same lab, for the next stage of the same order. */}
        {live && goesAgain && mayEdit && <ResendForm c={live} m={m} tz={tz} after={after} ready={ready} labName={nameOf(live.labId)} />}
      </div>
    </li>
  );
}

type CaseOp = { op: "received" | "sent" | "cancel" } | { op: "cost"; cost: number };

/** The order itself: what the lab was told, and what may still be changed about it. */
function CaseMore({ c, m, mayEdit, onOp, onRemake }: { c: LabCase; m: Mark; mayEdit: boolean; onOp: (op: CaseOp) => Promise<boolean>; onRemake?: () => void }) {
  const { t } = useI18n();
  const L = t.dental.lab;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <div className="grid gap-1.5 ps-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78125rem]">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex h-7 items-center gap-1 font-semibold text-brand-700 hover:underline" data-lab-order-toggle={c.id}>
          {L.order}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {mayEdit && !c.paid && !editing && (
          <>
            <button type="button" onClick={() => setEditing(true)} className="inline-flex h-7 items-center gap-1 font-semibold text-brand-700 hover:underline" aria-label={L.editCost}>
              <Pencil className="h-3 w-3" />
              {L.editCost}
            </button>
            <button type="button" onClick={() => void onOp({ op: "cancel" })} className="h-7 font-semibold text-ink-500 hover:text-danger" data-lab-cancel={c.id}>
              {L.cancel}
            </button>
          </>
        )}
        {mayEdit && onRemake && (
          <button type="button" onClick={onRemake} className="h-7 font-semibold text-ink-500 hover:text-ink-900" data-lab-remake={m.id}>
            {L.sendAgain}
          </button>
        )}
      </div>
      {editing && <CostForm c={c} onSave={async (cost) => (await onOp({ op: "cost", cost })) && setEditing(false)} />}
      {open && <LabOrder c={c} m={m} />}
    </div>
  );
}

/** What the lab was told to make, as the chart had it when it was sent. */
function LabOrder({ c, m }: { c: LabCase; m: Mark }) {
  const { t } = useI18n();
  const L = t.dental.lab;
  const teeth = c.spec.teeth ?? [];
  const by = (role: "abutment" | "pontic") => teeth.filter((x) => x.role === role).map((x) => (x.implant ? `${x.site} (${L.onImplant})` : x.site));
  const material = c.spec.material ? (detailOptions(m.treatmentKey, "material").find((o) => o.key === c.spec.material)?.en ?? c.spec.material) : null;
  const arch = !isToothSite(m.site);
  const rows: [string, string][] = [
    ...(teeth.length > 1 ? ([[L.orderTeeth, arch ? `${teeth[0].site}–${teeth[teeth.length - 1].site}` : teeth.map((x) => x.site).join(" · ")]] as [string, string][]) : []),
    ...(!arch && teeth.length > 1 && by("abutment").length ? ([[L.orderSupports, by("abutment").join(" · ")]] as [string, string][]) : []),
    ...(!arch && by("pontic").length ? ([[L.orderReplaced, by("pontic").join(" · ")]] as [string, string][]) : []),
    ...(material ? ([[t.dental.details.material, material]] as [string, string][]) : []),
    ...(c.shade ? ([[L.shade, c.shade]] as [string, string][]) : []),
    ...((c.spec.implants ?? []).length
      ? ([[L.orderImplants, (c.spec.implants ?? []).map((i) => [i.site, i.system, i.diameter && i.length ? `${i.diameter}×${i.length}` : ""].filter(Boolean).join(" ")).join(" · ")]] as [string, string][])
      : []),
    ...(c.note ? ([[L.orderNote, c.note]] as [string, string][]) : []),
  ];
  if (!rows.length) return <p className="text-[0.78125rem] text-ink-500">{L.orderEmpty}</p>;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-ctl bg-surface px-3 py-2 text-[0.78125rem]" data-lab-order={c.id}>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-500">{k}</dt>
          <dd className="min-w-0 break-words font-medium text-ink-900 tnum">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CostForm({ c, onSave }: { c: LabCase; onSave: (cost: number) => unknown }) {
  const { t } = useI18n();
  const L = t.dental.lab;
  const [text, setText] = useState(String(c.cost));
  const value = Number(text.replace(",", "."));
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (Number.isFinite(value) && value >= 0) void onSave(Math.round(value * 100) / 100);
      }}
    >
      <input
        autoFocus
        inputMode="decimal"
        dir="ltr"
        value={text}
        onChange={(e) => /^\d{0,7}([.,]\d{0,2})?$/.test(e.target.value) && setText(e.target.value)}
        aria-label={L.cost}
        className="h-8 w-20 rounded-ctl border border-line bg-surface px-2 text-end text-base tnum md:text-sm"
        data-lab-cost-input={c.id}
      />
      <button type="submit" className="h-8 rounded-ctl bg-brand-600 px-2.5 text-[0.78125rem] font-semibold text-on-brand">
        {t.dental.price.save}
      </button>
    </form>
  );
}

function CaseRow({
  c,
  m,
  name,
  today,
  fmt,
  mayEdit,
  onOp,
}: {
  c: LabCase;
  m: Mark;
  name: string;
  today: string;
  fmt: (n: number) => string;
  mayEdit: boolean;
  onOp: (op: CaseOp) => Promise<boolean>;
}) {
  const { t, locale } = useI18n();
  const L = t.dental.lab;
  const [editing, setEditing] = useState(false);
  const late = isOverdue(c, today);
  const where =
    c.status === "cancelled"
      ? L.cancelled
      : c.status === "received"
        ? L.back
        : late
          ? L.late.replace("{date}", fmtDateOnly(c.dueOn!, locale))
          : c.dueOn
            ? L.due.replace("{date}", fmtDateOnly(c.dueOn, locale))
            : L.atLab;
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-ctl px-2.5 py-1.5 text-[0.78125rem] ${c.status === "cancelled" ? "bg-sunken text-ink-400 line-through" : "bg-canvas"}`}
      data-lab-case={c.id}
      data-lab-status={c.status}
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0 text-ink-400" />
      <span className="font-semibold text-ink-900">{name}</span>
      {LAB_TRIPS[m.treatmentKey] && <span className="text-ink-700">{L.stages[c.stage]}</span>}
      <span className={late ? "font-semibold text-danger" : "text-ink-500"}>{where}</span>
      {editing ? (
        <CostForm c={c} onSave={async (cost) => (await onOp({ op: "cost", cost })) && setEditing(false)} />
      ) : (
        <span className="font-semibold tnum text-ink-900" data-lab-cost={c.id}>
          {fmt(c.cost)}
        </span>
      )}
      {c.paid && <span className="rounded-full bg-sunken px-2 py-0.5 text-[length:max(11px,0.6875rem)] font-semibold text-ink-500">{L.paid}</span>}
      {mayEdit && c.status !== "cancelled" && !editing && (
        <span className="ms-auto flex flex-wrap gap-1.5">
          {c.status === "sent" ? (
            <button type="button" onClick={() => void onOp({ op: "received" })} className="h-7 rounded-full bg-brand-600 px-2.5 font-semibold text-on-brand hover:bg-brand-hover" data-lab-received={c.id}>
              {L.received}
            </button>
          ) : (
            <button type="button" onClick={() => void onOp({ op: "sent" })} className="h-7 rounded-full px-2 font-semibold text-ink-500 hover:text-ink-900" data-lab-undo={c.id}>
              {L.notBack}
            </button>
          )}
          {!c.paid && (
            <>
              <button type="button" onClick={() => setEditing(true)} className="inline-flex h-7 items-center gap-1 rounded-full px-2 font-semibold text-brand-700 hover:bg-brand-50" aria-label={L.editCost}>
                <Pencil className="h-3 w-3" />
                {L.editCost}
              </button>
              <button type="button" onClick={() => void onOp({ op: "cancel" })} className="h-7 rounded-full px-2 font-semibold text-ink-500 hover:text-danger" data-lab-cancel={c.id}>
                {L.cancel}
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** When it is due back: a few usual spans, or a day. */
function DueField({ value, onChange, tz }: { value: string | null; onChange: (d: string | null) => void; tz: string }) {
  const { t } = useI18n();
  const L = t.dental.lab;
  const today = DateTime.now().setZone(tz);
  return (
    <div className="grid gap-1">
      <span className="text-[0.75rem] font-semibold text-ink-500">{L.dueBack}</span>
      <div className="flex flex-wrap gap-1.5">
        {[3, 5, 7, 10].map((n) => {
          const d = today.plus({ days: n }).toISODate()!;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={value === d}
              onClick={() => onChange(value === d ? null : d)}
              className={`h-8 rounded-full border px-3 text-[0.78125rem] font-semibold ${value === d ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700"}`}
              data-lab-due={n}
            >
              {L.inDays.replace("{n}", String(n))}
            </button>
          );
        })}
        <input
          type="date"
          value={value ?? ""}
          min={today.toISODate()!}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label={L.dueBack}
          className="h-8 rounded-ctl border border-line bg-surface px-2 text-[0.78125rem]"
        />
      </div>
    </div>
  );
}

/** What the lab is to send back, one tap. */
function StageField({ value, offers, onChange }: { value: LabStage; offers: LabStage[]; onChange: (s: LabStage) => void }) {
  const { t } = useI18n();
  const L = t.dental.lab;
  return (
    <div className="grid gap-1">
      <span className="text-[0.75rem] font-semibold text-ink-500">{L.stage}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup">
        {offers.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={value === s}
            onClick={() => onChange(s)}
            className={`h-9 rounded-full border px-3 text-[0.8125rem] font-semibold ${value === s ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:bg-sunken"}`}
            data-lab-stage={s}
          >
            {L.stages[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Back to the lab: the next stage of the order it already has, at the price it already has. */
function ResendForm({ c, m, tz, after, ready, labName }: { c: LabCase; m: Mark; tz: string; after: string; ready: boolean; labName: string }) {
  const { t } = useI18n();
  const L = t.dental.lab;
  const w = useChartWriter();
  const offers = stagesFor(m.treatmentKey, after);
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<LabStage>(offers[0]);
  const [dueOn, setDueOn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[0.8125rem]">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface text-ink-500 ring-1 ring-line">
          <FlaskConical className="h-3.5 w-3.5" />
        </span>
        <span className="text-ink-500">{ready ? L.readyForLab : L.thenLab}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`ms-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[0.78125rem] font-semibold ${ready ? "bg-brand-600 text-on-brand hover:bg-brand-hover" : "border border-line-strong text-ink-700 hover:bg-sunken"}`}
          data-lab-resend={c.id}
        >
          <FlaskConical className="h-3.5 w-3.5" />
          {L.sendBack}
        </button>
      </div>
    );
  }
  return (
    <form
      className="grid gap-2.5 rounded-ctl border border-line bg-surface p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await w.labCaseOp(c, { op: "resend", stage, dueOn });
        setBusy(false);
        if (ok) setOpen(false);
      }}
      data-lab-resend-form={c.id}
    >
      <p className="text-[0.8125rem] text-ink-700">
        <span className="font-semibold text-ink-900">{labName}</span> · {L.sameOrder}
      </p>
      <StageField value={stage} offers={offers} onChange={setStage} />
      <DueField value={dueOn} onChange={setDueOn} tz={tz} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-ctl px-3 text-[0.8125rem] font-semibold text-ink-500 hover:bg-sunken">
          {t.dental.price.cancel}
        </button>
        <button type="submit" disabled={busy} className="h-9 rounded-ctl bg-brand-600 px-3.5 text-[0.8125rem] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-45" data-lab-resend-save>
          {L.sendBack}
        </button>
      </div>
    </form>
  );
}

/** Send to lab: which lab, what it costs, when it is due back, the shade — and for a bridge, what is to come back. */
function SendForm({ m, tz, onClose }: { m: Mark; tz: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const L = t.dental.lab;
  const store = useDentalStore();
  const w = useChartWriter();
  const labs = store.labs.filter((l) => l.active);
  const variant = variantOf(m.treatmentKey, m.detail);
  const units = unitsOf(m, store.marks);
  const offers = stagesFor(m.treatmentKey);
  const staged = !!LAB_TRIPS[m.treatmentKey];
  // The lab this clinic last sent this treatment to, else its own lab, else the first.
  const last = [...store.labCases].reverse().find((c) => store.marks.find((x) => x.id === c.markId)?.treatmentKey === m.treatmentKey);
  const first = (last && labs.find((l) => l.id === last.labId)) || labs.find((l) => l.inHouse) || labs[0];
  const [labId, setLabId] = useState(first?.id ?? "");
  const costAt = (id: string) => labCostFor(store.labPrices, id, m.treatmentKey, variant, units);
  const each = labPriceFor(store.labPrices, labId, m.treatmentKey, variant);
  const [cost, setCost] = useState(() => (first ? String(costAt(first.id) ?? "") : ""));
  const shadeStep = store.steps.find((s) => s.markId === m.id && !s.voidedAt && typeof (s.data as Record<string, unknown>)?.shade === "string");
  const [shade, setShade] = useState(((shadeStep?.data as Record<string, unknown>)?.shade as string) ?? "");
  const [stage, setStage] = useState<LabStage>(offers[0]);
  const [dueOn, setDueOn] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const value = Number(cost.replace(",", "."));
  const valid = !!labId && cost.trim() !== "" && Number.isFinite(value) && value >= 0;
  const teeth = m.groupId && PER_TOOTH.has(m.treatmentKey) ? store.marks.filter((x) => x.groupId === m.groupId && !x.voidedAt && isToothSite(x.site)) : [];
  const kind = PRICE_BY[m.treatmentKey] === "material" ? variantName(m.treatmentKey, variant, locale) : null;

  return (
    <form
      className="grid gap-2.5 rounded-ctl border border-line bg-canvas p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        const ok = await w.sendToLab(m, { labId, cost: Math.round(value * 100) / 100, dueOn, shade: shade.trim(), note: note.trim(), stage: staged ? stage : "finish" });
        setBusy(false);
        if (ok) onClose();
      }}
      data-lab-form={m.id}
    >
      {/* What goes with it, read from the chart: nobody types a bridge's teeth to the lab. */}
      {teeth.length > 1 && (
        <p className="text-[0.78125rem] text-ink-700" data-lab-form-teeth={teeth.length}>
          <span className="font-semibold text-ink-900">{L.orderTeeth}</span> {teeth.map((x) => `${x.site}${x.role === "pontic" ? ` ${L.replaced}` : ""}`).join(" · ")}
          {kind ? ` · ${kind}` : ""}
        </p>
      )}
      <label className="grid gap-1 text-[0.75rem] font-semibold text-ink-500">
        {L.lab}
        <select
          value={labId}
          onChange={(e) => {
            setLabId(e.target.value);
            const p = costAt(e.target.value);
            if (p != null) setCost(String(p));
          }}
          className="select-chevron h-9 appearance-none rounded-ctl border border-line bg-surface ps-2.5 pe-8 text-base md:text-sm"
          data-lab-pick
        >
          {labs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.inHouse ? ` · ${L.inHouse}` : ""}
            </option>
          ))}
        </select>
      </label>
      {staged && <StageField value={stage} offers={offers} onChange={setStage} />}
      <div className="grid grid-cols-2 gap-2.5">
        <label className="grid gap-1 text-[0.75rem] font-semibold text-ink-500">
          {L.cost}
          <span className="flex h-9 items-center rounded-ctl border border-line bg-surface" dir="ltr">
            <input
              inputMode="decimal"
              value={cost}
              onChange={(e) => /^\d{0,7}([.,]\d{0,2})?$/.test(e.target.value) && setCost(e.target.value)}
              className="h-full w-full min-w-0 rounded-ctl bg-transparent px-2 text-base font-semibold tnum focus:outline-none md:text-sm"
              data-lab-cost-field
            />
            <span className="pe-2 text-[0.75rem] font-semibold text-ink-400">{store.currency}</span>
          </span>
          {units > 1 && each != null && (
            <span className="text-[length:max(11px,0.71875rem)] font-medium text-ink-500 tnum" data-lab-per-tooth>
              {L.perTooth.replace("{price}", fmtMoney(each, store.currency, locale)).replace("{n}", String(units))}
            </span>
          )}
        </label>
        <label className="grid content-start gap-1 text-[0.75rem] font-semibold text-ink-500">
          {L.shade}
          <input value={shade} maxLength={40} onChange={(e) => setShade(e.target.value)} placeholder="A2" className="h-9 rounded-ctl border border-line bg-surface px-2 text-base md:text-sm" />
        </label>
      </div>
      <DueField value={dueOn} onChange={setDueOn} tz={tz} />
      <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder={L.notePlaceholder} className="h-9 rounded-ctl border border-line bg-surface px-2 text-base md:text-sm" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 rounded-ctl px-3 text-[0.8125rem] font-semibold text-ink-500 hover:bg-sunken">
          {t.dental.price.cancel}
        </button>
        <button type="submit" disabled={!valid || busy} className="h-9 rounded-ctl bg-brand-600 px-3.5 text-[0.8125rem] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-45" data-lab-send-save>
          {L.sendSave}
        </button>
      </div>
    </form>
  );
}
