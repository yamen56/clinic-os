"use client";

/*
  The plan, beside the chart: treatment 1, treatment 2, treatment 3.

  What the dentist asked to see without scrolling: what is under way and how
  far along, what comes next and at which visit, and what is done. A
  treatment with steps opens its card; a one-tap treatment is ticked off here.
  "Book next visit" carries the chosen treatments into the calendar, so the
  appointment knows what it is for.
*/

import { useMemo, useState } from "react";
import { CalendarPlus, Check, ChevronRight, Siren } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { findTreatment } from "@/lib/charts/dental/catalog";
import { isToothSite, paintAt, type Mark } from "@/lib/charts/dental/state";
import { tooth as toothOf } from "@/lib/charts/dental/teeth";
import { progressOf } from "@/lib/charts/dental/protocols";
import { groupLeads, leadOf } from "@/lib/charts/dental/full-arch";
import { isUpcoming, nextVisitOf, sessionsOf } from "@/lib/charts/dental/treatment";
import { useDentalStore } from "./store";
import { detailLabels, markLabel, siteLabel } from "./labels";
import { TreatmentGlyph } from "./treatment-picker";
import { INK, SOFT } from "./tooth-art";
import { moneyOf, type Money } from "./money";
import { fmtMoney } from "@/lib/dates";

const ORDER_OF_SITE = (s: string) => (isToothSite(s) ? Number(s) : 0);

export function PlanPanel({
  tz,
  extraOf,
  onDone,
  columns,
}: {
  tz: string;
  /** Above the chart on a narrower screen: two to a row, so the chart is not pushed far down. */
  columns?: boolean;
  /** A group's own line — a full arch's implants. */
  extraOf: (m: Mark) => string | undefined;
  /** Tick off a one-tap treatment. */
  onDone: (m: Mark) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const P = T.treatment;
  const store = useDentalStore();
  const { marks, steps, custom, activeCaseId, visits, bookings, canWrite, canBook } = store;
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const leads = useMemo(() => groupLeads(marks), [marks]);
  // The case's treatments — not its findings, not work done elsewhere — each once, as its group's lead.
  const items = useMemo(
    () =>
      marks
        .filter((m) => m.caseId === activeCaseId && !m.voidedAt && m.kind === "procedure" && m.status !== "existing" && !leadOf(m, leads))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || ORDER_OF_SITE(a.site) - ORDER_OF_SITE(b.site)),
    [marks, activeCaseId, leads]
  );
  const stepsOf = (id: string) => steps.filter((s) => s.markId === id);
  const underway = items.filter((m) => m.status === "planned" && m.startedAt);
  const planned = items.filter((m) => m.status === "planned" && !m.startedAt);
  const done = items.filter((m) => m.status === "done");

  // The next visit any of these treatments is booked into, and what it is for.
  const next = useMemo(() => {
    const upcoming = visits.filter((v) => isUpcoming(v)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const ids = new Set(items.map((m) => m.id));
    for (const v of upcoming) {
      const forIt = bookings.filter((b) => b.appointmentId === v.id && ids.has(b.markId)).map((b) => b.markId);
      if (forIt.length) return { visit: v, items: forIt };
    }
    return null;
  }, [visits, bookings, items]);

  const startBooking = () => {
    // What is under way and not yet booked is what the next visit is usually for.
    setChosen(new Set(underway.filter((m) => !nextVisitOf(m.id, bookings, visits)).map((m) => m.id)));
    setPicking(true);
  };
  const toggle = (id: string) =>
    setChosen((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const moneyCtx = { marks, steps, prices: store.prices, billing: store.billing, billingSince: store.billingSince, tz };
  const money = new Map<string, Money>(items.map((m) => [m.id, moneyOf(m, moneyCtx)]));
  const cost = (list: Mark[]) => list.reduce((sum, m) => sum + (money.get(m.id)?.amount ?? 0), 0);
  const priced = items.some((m) => m.fee != null);
  // What reception can bill now: started or done, and not yet on an invoice.
  const toBill = store.canBill ? items.filter((m) => money.get(m.id)?.toBill) : [];
  // Billed: each treatment's fee times the units on invoices that stand. To bill: what waits.
  const billedSum = items.reduce((sum, m) => {
    const c = money.get(m.id);
    return sum + (c?.fee != null ? c.fee * c.billedQty : 0);
  }, 0);
  const dueSum = items.reduce((sum, m) => sum + (money.get(m.id)?.due ?? 0), 0);
  const fmt = (n: number) => fmtMoney(n, store.currency, locale);

  const row = (m: Mark) => {
    const tr = findTreatment(m.treatmentKey, custom);
    const cash = money.get(m.id);
    const own = stepsOf(m.id);
    const prog = progressOf(m.treatmentKey, own);
    const { sessions, emergencies } = sessionsOf(own, tz);
    const tt = isToothSite(m.site) ? toothOf(m.site) : null;
    const paint = paintAt(m, null) ?? "planned";
    const details = extraOf(m) ?? detailLabels(m, custom, locale).join(" · ");
    const booked = nextVisitOf(m.id, bookings, visits);
    const open = () => store.setOpenItem(m.id);
    return (
      <li key={m.id} className="flex items-stretch gap-2" data-plan-item={m.id} data-plan-state={m.status === "done" ? "done" : m.startedAt ? "progress" : "planned"}>
        {picking && m.status === "planned" && (
          <input type="checkbox" checked={chosen.has(m.id)} onChange={() => toggle(m.id)} className="mt-3 h-4.5 w-4.5 shrink-0 accent-brand-600" aria-label={markLabel(m, locale)} data-book-pick={m.id} />
        )}
        <div className="flex min-w-0 flex-1 items-start gap-2.5 rounded-card border border-line bg-surface p-2.5">
          {tr && <TreatmentGlyph tr={tr} paint={paint} context={tt} size={40} />}
          <button type="button" onClick={open} className="min-w-0 flex-1 text-start">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="font-display text-[14px] font-bold text-ink-900 tnum">{isToothSite(m.site) ? m.site : siteLabel(m.site, T)}</span>
              <span className="text-[13.5px] font-semibold text-ink-900">{markLabel(m, locale)}</span>
              {m.emergency && <Siren className="h-3.5 w-3.5 text-danger" aria-label={P.emergency} />}
            </span>
            {details && <span className="block text-[12px] text-ink-500">{details}</span>}
            {prog && m.status === "planned" && (
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                <span className="inline-flex gap-0.5" aria-hidden>
                  {prog.steps
                    .filter((s) => !s.optional)
                    .map((s) => (
                      <span key={s.key} className="h-2 w-2 rounded-full" style={{ background: prog.done.has(s.key) ? INK.progress : "var(--color-line)" }} />
                    ))}
                </span>
                <span className="font-semibold" style={{ color: INK.progress }} data-next-step={prog.next?.key ?? ""}>
                  {prog.next ? P.nextStep.replace("{step}", prog.next.en) : P.allStepsDone}
                </span>
                {sessions > 0 && <span className="text-ink-500">{sessions === 1 ? P.session : P.sessions.replace("{n}", String(sessions))}</span>}
                {emergencies > 0 && <span className="text-danger">{P.emergencies.replace("{n}", String(emergencies))}</span>}
              </span>
            )}
            {m.status === "done" && <span className="mt-0.5 block text-[12px] text-ink-500">{fmtDate(m.doneAt ?? m.createdAt, tz, locale)}</span>}
            {booked && m.status === "planned" && (
              <span className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-500">
                <CalendarPlus className="h-3 w-3" />
                {fmtDateTime(booked.startsAt, tz, locale)}
              </span>
            )}
          </button>
          {/* What it costs this patient, and — for reception — whether it is billed. */}
          {(cash?.amount != null || (store.canBill && cash?.billed)) && (
            <span className="shrink-0 self-center text-end" data-plan-price={cash?.amount ?? ""}>
              {cash?.amount != null && <span className="block text-[13px] font-semibold text-ink-900 tnum">{fmt(cash.amount)}</span>}
              {store.canBill && cash?.billed && <span className="block text-[11px] font-semibold" style={{ color: INK.done }}>{P.billed}</span>}
            </span>
          )}
          {m.status === "planned" && !prog && canWrite && (
            <button
              type="button"
              onClick={() => onDone(m)}
              className="inline-flex h-8 shrink-0 items-center gap-1 self-center rounded-ctl px-2.5 text-[12.5px] font-semibold"
              style={{ background: SOFT.done, color: INK.done }}
              data-plan-done={m.id}
            >
              <Check className="h-3.5 w-3.5" />
              {T.markDone}
            </button>
          )}
          {prog && (
            <button type="button" onClick={open} aria-label={P.open} className="grid h-8 w-8 shrink-0 place-items-center self-center rounded-ctl text-ink-400 hover:bg-sunken">
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </li>
    );
  };

  const section = (title: string, list: Mark[], key: string) =>
    list.length > 0 && (
      <section key={key} data-plan-section={key}>
        <h4 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-ink-500">
          {title}
          <span className="rounded-full bg-sunken px-1.5 text-[11px] text-ink-500 tnum">{list.length}</span>
        </h4>
        <ul className={`grid gap-1.5 ${columns ? "md:grid-cols-2" : ""}`}>{list.map(row)}</ul>
      </section>
    );

  return (
    <div className="flex flex-col gap-4" data-plan>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-base font-semibold text-ink-900">{P.plan}</h3>
      </div>

      {/* The next visit, first — what the patient is coming back for. */}
      <div className="rounded-card px-3 py-2.5" style={{ background: next ? SOFT.done : "var(--color-canvas)" }} data-plan-next={next?.visit.id ?? ""}>
        {next ? (
          <>
            <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: INK.done }}>
              {P.nextVisit}
            </div>
            <div className="text-[14px] font-semibold text-ink-900">
              {fmtDateTime(next.visit.startsAt, tz, locale)}
              {next.visit.doctor ? ` · ${next.visit.doctor}` : ""}
            </div>
            <div className="mt-0.5 text-[12.5px] text-ink-700">
              {/* What is still to do at it: a treatment finished since it was booked is no longer what the visit is for. */}
              {next.items
                .map((id) => marks.find((m) => m.id === id))
                .filter((m): m is Mark => !!m && m.status === "planned")
                .map((m) => {
                  const prog = progressOf(m.treatmentKey, stepsOf(m.id));
                  return `${isToothSite(m.site) ? `${m.site} ` : ""}${markLabel(m, locale)}${prog?.next ? ` — ${prog.next.en}` : ""}`;
                })
                .join(" · ")}
            </div>
          </>
        ) : (
          <div className="text-[13px] text-ink-500">{P.notBooked}</div>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-[13px] text-ink-500">{P.nothingPlanned}</p>
      ) : (
        <>
          {section(P.inProgress, underway, "progress")}
          {section(P.planned, planned, "planned")}
          {section(P.done, done, "done")}
        </>
      )}

      {/* The plan in money: what it all comes to, what is done, and what reception can bill now. */}
      {(priced || toBill.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card bg-canvas px-3 py-2.5 text-[13px]" data-plan-totals>
          {priced && (
            <>
              <span>
                <span className="text-ink-500">{P.planTotal} </span>
                <span className="font-semibold text-ink-900 tnum" data-plan-total={cost(items)}>{fmt(cost(items))}</span>
              </span>
              <span>
                <span className="text-ink-500">{P.doneTotal} </span>
                <span className="font-semibold text-ink-900 tnum">{fmt(cost(done))}</span>
              </span>
              {store.canBill && (
                <span>
                  <span className="text-ink-500">{P.billed} </span>
                  <span className="font-semibold text-ink-900 tnum" data-plan-billed={billedSum}>{fmt(billedSum)}</span>
                </span>
              )}
              {store.canBill && dueSum > 0 && (
                <span>
                  <span className="text-ink-500">{P.dueTotal} </span>
                  <span className="font-semibold text-st-pending tnum" data-plan-due={dueSum}>{fmt(dueSum)}</span>
                </span>
              )}
            </>
          )}
          {toBill.length > 0 && (
            <a
              href={`/c/${store.slug}/invoices/new?patient=${store.patientId}&marks=${toBill.map((m) => m.id).join(",")}`}
              className={buttonClass({ size: "sm", className: "ms-auto" })}
              data-bill={toBill.length}
            >
              {P.bill} · {P.toBill.replace("{n}", String(toBill.length))}
            </a>
          )}
        </div>
      )}

      {(canBook || canWrite) && (
        <div className="grid gap-2 border-t border-line pt-3">
          {picking ? (
            <>
              <p className="text-[12.5px] text-ink-500">{P.bookPick}</p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={chosen.size ? `/c/${store.slug}/calendar?patient=${store.patientId}&items=${[...chosen].join(",")}` : undefined}
                  aria-disabled={!chosen.size}
                  className={buttonClass({ size: "sm", className: chosen.size ? "" : "pointer-events-none opacity-50" })}
                  data-book-go
                >
                  {P.bookGo}
                </a>
                <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
                  {T.cancel}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              {canBook && underway.length + planned.length > 0 && (
                <Button variant="outline" size="sm" onClick={startBooking} data-book-next-visit>
                  <CalendarPlus className="h-4 w-4" />
                  {P.bookNext}
                </Button>
              )}
              {canWrite && (
                <Button variant="outline" size="sm" onClick={() => store.setEmergency({})} data-emergency>
                  <Siren className="h-4 w-4" />
                  {P.emergency}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
