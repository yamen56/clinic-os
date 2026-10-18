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
*/

import { useState } from "react";
import Link from "next/link";
import { FlaskConical, Pencil } from "lucide-react";
import { DateTime } from "luxon";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly, fmtMoney } from "@/lib/dates";
import type { Mark } from "@/lib/charts/dental/state";
import { variantOf } from "@/lib/charts/dental/pricing";
import { leadIdOf } from "@/lib/charts/dental/full-arch";
import { LAB_AFTER_STEP, LAB_TREATMENTS, isOverdue, labPriceFor, type LabCase } from "@/lib/charts/dental/labs";
import { useDentalStore } from "./store";
import { useChartWriter } from "./writer";
import { priceable } from "./price-line";

export function LabLine({ m, tz }: { m: Mark; tz: string }) {
  const { t, locale } = useI18n();
  const L = t.dental.lab;
  const store = useDentalStore();
  const w = useChartWriter();
  const [open, setOpen] = useState(false);
  if (!priceable(m, store.marks)) return null;
  // A bridge goes to the lab once, on its lead — the tooth its invoice line bills, so its cost reaches the share.
  const mates = m.groupId ? store.marks.filter((x) => x.groupId === m.groupId && !x.voidedAt) : [];
  if (mates.length > 1 && leadIdOf(mates) !== m.id) return null;
  const cases = store.labCases.filter((c) => c.markId === m.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const isLabWork = LAB_TREATMENTS.has(m.treatmentKey);
  const mayEdit = store.canWrite || store.canBill;
  // Nothing to say about lab work on a filling nobody sent anywhere.
  if (!cases.length && !isLabWork && !mayEdit) return null;
  const today = DateTime.now().setZone(tz).toISODate()!;
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);
  // Names for every case, an archived lab's too; only labs in use are offered to send to.
  const labName = (id: string) => store.labs.find((l) => l.id === id)?.name ?? "—";
  const active = store.labs.filter((l) => l.active);
  // The work is ready to go once its impression is taken.
  const after = LAB_AFTER_STEP[m.treatmentKey];
  const impressionTaken = !after || store.steps.some((s) => s.markId === m.id && s.step === after && !s.voidedAt);
  const live = cases.some((c) => c.status !== "cancelled");

  return (
    <div className="grid gap-1.5" data-lab-line={m.id}>
      {cases.map((c) => (
        <CaseRow key={c.id} c={c} name={labName(c.labId)} today={today} fmt={fmt} mayEdit={mayEdit} onOp={(op) => w.labCaseOp(c, op)} />
      ))}
      {mayEdit && !open && (isLabWork || cases.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          {active.length === 0 ? (
            <>
              <span className="text-ink-500">{L.noLabs}</span>
              {store.canPrice && (
                <Link href={`/c/${store.slug}/settings/labs`} className="font-semibold text-brand-700 hover:underline">
                  {L.setUp}
                </Link>
              )}
            </>
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
        <button type="button" onClick={() => setOpen(true)} className="justify-self-start text-[12px] font-semibold text-ink-500 hover:text-ink-900 hover:underline" data-lab-add={m.id}>
          {L.add}
        </button>
      )}
      {open && <SendForm m={m} tz={tz} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CaseRow({
  c,
  name,
  today,
  fmt,
  mayEdit,
  onOp,
}: {
  c: LabCase;
  name: string;
  today: string;
  fmt: (n: number) => string;
  mayEdit: boolean;
  onOp: (op: { op: "received" | "sent" | "cancel" } | { op: "cost"; cost: number }) => Promise<boolean>;
}) {
  const { t, locale } = useI18n();
  const L = t.dental.lab;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(c.cost));
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
  const value = Number(text.replace(",", "."));
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-ctl px-2.5 py-1.5 text-[12.5px] ${c.status === "cancelled" ? "bg-sunken text-ink-400 line-through" : "bg-canvas"}`}
      data-lab-case={c.id}
      data-lab-status={c.status}
    >
      <FlaskConical className="h-3.5 w-3.5 shrink-0 text-ink-400" />
      <span className="font-semibold text-ink-900">{name}</span>
      <span className={late ? "font-semibold text-danger" : "text-ink-500"}>{where}</span>
      {editing ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!(Number.isFinite(value) && value >= 0)) return;
            if (await onOp({ op: "cost", cost: Math.round(value * 100) / 100 })) setEditing(false);
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
          <button type="submit" className="h-8 rounded-ctl bg-brand-600 px-2.5 font-semibold text-on-brand">
            {t.dental.price.save}
          </button>
        </form>
      ) : (
        <span className="font-semibold tnum text-ink-900" data-lab-cost={c.id}>
          {fmt(c.cost)}
        </span>
      )}
      {c.paid && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold text-ink-500">{L.paid}</span>}
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

/** Send to lab: which lab, what it costs, when it is due back, the shade. */
function SendForm({ m, tz, onClose }: { m: Mark; tz: string; onClose: () => void }) {
  const { t } = useI18n();
  const L = t.dental.lab;
  const store = useDentalStore();
  const w = useChartWriter();
  const labs = store.labs.filter((l) => l.active);
  const variant = variantOf(m.treatmentKey, m.detail);
  // The lab this clinic last sent this treatment to, else its own lab, else the first.
  const last = [...store.labCases].reverse().find((c) => store.marks.find((x) => x.id === c.markId)?.treatmentKey === m.treatmentKey);
  const first = (last && labs.find((l) => l.id === last.labId)) || labs.find((l) => l.inHouse) || labs[0];
  const [labId, setLabId] = useState(first?.id ?? "");
  const priceAt = (id: string) => labPriceFor(store.labPrices, id, m.treatmentKey, variant);
  const [cost, setCost] = useState(() => (first ? String(priceAt(first.id) ?? "") : ""));
  const shadeStep = store.steps.find((s) => s.markId === m.id && !s.voidedAt && typeof (s.data as Record<string, unknown>)?.shade === "string");
  const [shade, setShade] = useState(((shadeStep?.data as Record<string, unknown>)?.shade as string) ?? "");
  const [dueOn, setDueOn] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const today = DateTime.now().setZone(tz);
  const value = Number(cost.replace(",", "."));
  const valid = !!labId && cost.trim() !== "" && Number.isFinite(value) && value >= 0;

  return (
    <form
      className="grid gap-2.5 rounded-ctl border border-line bg-canvas p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        const ok = await w.sendToLab(m, { labId, cost: Math.round(value * 100) / 100, dueOn, shade: shade.trim(), note: note.trim() });
        setBusy(false);
        if (ok) onClose();
      }}
      data-lab-form={m.id}
    >
      <label className="grid gap-1 text-[12px] font-semibold text-ink-500">
        {L.lab}
        <select
          value={labId}
          onChange={(e) => {
            setLabId(e.target.value);
            const p = priceAt(e.target.value);
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
      <div className="grid grid-cols-2 gap-2.5">
        <label className="grid gap-1 text-[12px] font-semibold text-ink-500">
          {L.cost}
          <span className="flex h-9 items-center rounded-ctl border border-line bg-surface" dir="ltr">
            <input
              inputMode="decimal"
              value={cost}
              onChange={(e) => /^\d{0,7}([.,]\d{0,2})?$/.test(e.target.value) && setCost(e.target.value)}
              className="h-full w-full min-w-0 rounded-ctl bg-transparent px-2 text-base font-semibold tnum focus:outline-none md:text-sm"
              data-lab-cost-field
            />
            <span className="pe-2 text-[12px] font-semibold text-ink-400">{store.currency}</span>
          </span>
        </label>
        <label className="grid gap-1 text-[12px] font-semibold text-ink-500">
          {L.shade}
          <input value={shade} maxLength={40} onChange={(e) => setShade(e.target.value)} placeholder="A2" className="h-9 rounded-ctl border border-line bg-surface px-2 text-base md:text-sm" />
        </label>
      </div>
      <div className="grid gap-1">
        <span className="text-[12px] font-semibold text-ink-500">{L.dueBack}</span>
        <div className="flex flex-wrap gap-1.5">
          {[3, 5, 7, 10].map((n) => {
            const d = today.plus({ days: n }).toISODate()!;
            return (
              <button
                key={n}
                type="button"
                aria-pressed={dueOn === d}
                onClick={() => setDueOn(dueOn === d ? null : d)}
                className={`h-8 rounded-full border px-3 text-[12.5px] font-semibold ${dueOn === d ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700"}`}
                data-lab-due={n}
              >
                {L.inDays.replace("{n}", String(n))}
              </button>
            );
          })}
          <input
            type="date"
            value={dueOn ?? ""}
            min={today.toISODate()!}
            onChange={(e) => setDueOn(e.target.value || null)}
            aria-label={L.dueBack}
            className="h-8 rounded-ctl border border-line bg-surface px-2 text-[12.5px]"
          />
        </div>
      </div>
      <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder={L.notePlaceholder} className="h-9 rounded-ctl border border-line bg-surface px-2 text-base md:text-sm" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 rounded-ctl px-3 text-[13px] font-semibold text-ink-500 hover:bg-sunken">
          {t.dental.price.cancel}
        </button>
        <button type="submit" disabled={!valid || busy} className="h-9 rounded-ctl bg-brand-600 px-3.5 text-[13px] font-semibold text-on-brand hover:bg-brand-hover disabled:opacity-45" data-lab-send-save>
          {L.sendSave}
        </button>
      </div>
    </form>
  );
}
