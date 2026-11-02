"use client";

/*
  The desk's Ready to bill: every patient whose chart work is not on an
  invoice yet, and that work item by item — dental and face alike — as the
  invoice will word it, with who did it, when, and its price.

  Yamen, 2026-10-28: "I want the prices to appear … with the dental chart
  invoices that need to be billed so the receptionist can see them … a better
  design … and add a delete option". It used to be one line per patient — a
  count and a total — and reception had to open each file to see what the
  total was made of.

  Yamen, 2026-11-02: "minimise it so we can see the invoices clearly and add a
  faster delete button". So it opens as one line — how many patients, how
  much — above the invoices it was pushing off the screen, and each patient is
  one row whose items open under it. Remove takes an item (or a patient's
  whole list) off at once, with Undo on the toast instead of a confirm box.

  Each item is ticked; untick what is not going on this bill, and Bill opens
  the invoice with what is ticked. Remove takes an item off the list
  (removeFromBillingAction): it stays on the chart, at no charge.
*/

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, ChevronDown, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";
import { buttonClass } from "@/components/ui/button-class";
import { fmtDate, fmtMoney } from "@/lib/dates";
import type { DeskLine } from "@/lib/charts/dental/billing-server";
import { removeFromBillingAction, restoreToBillingAction } from "./actions";

export type DeskGroup = { patientId: string; name: string; lastAt: string; lines: DeskLine[] };

const SHOWN = 5;
/** Open or minimised, kept per browser — reception sets it once. */
const OPEN_KEY = "clinicti.readyToBill.open";
const amountOf = (l: DeskLine) => Math.round(l.unitPrice * l.qty * 100) / 100;

export function ReadyToBillDesk({
  slug,
  currency,
  tz,
  groups: initial,
  priceLinks,
}: {
  slug: string;
  currency: string;
  tz: string;
  groups: DeskGroup[];
  /** Where an unpriced item is priced, for a member who sets prices. */
  priceLinks: { dental: boolean; face: boolean };
}) {
  const { t, locale } = useI18n();
  const I = t.invoices;
  const { toast } = useToast();
  const [groups, setGroups] = useState(initial);
  useEffect(() => setGroups(initial), [initial]);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  // Null until this browser's choice is read: drawn minimised meanwhile, but not yet saying so.
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let v = false;
    try {
      v = localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      // minimised
    }
    setOpen(v);
  }, []);
  const toggleOpen = () => {
    const next = !open;
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // this visit only
    }
    setOpen(next);
  };

  // Where each item stood, so Undo puts it back in its place.
  const order = useMemo(() => new Map(initial.flatMap((g) => g.lines.map((l, i) => [l.markId, i] as const))), [initial]);

  const money = (n: number) => fmtMoney(n, currency, locale);
  const live = useMemo(() => groups.filter((g) => g.lines.length > 0), [groups]);
  const total = live.reduce((n, g) => n + g.lines.reduce((m, l) => m + amountOf(l), 0), 0);
  if (!live.length) return null;

  const toggle = (set: typeof setUnticked, id: string) =>
    set((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const putBack = (lines: DeskLine[]) =>
    setGroups((prev) =>
      prev.map((g) => {
        const back = lines.filter((l) => l.patientId === g.patientId && !g.lines.some((x) => x.markId === l.markId));
        if (!back.length) return g;
        return { ...g, lines: [...g.lines, ...back].sort((a, b) => (order.get(a.markId) ?? 0) - (order.get(b.markId) ?? 0)) };
      })
    );

  /* Off the list at once; the server catches up, and Undo is on the toast. */
  const remove = async (lines: DeskLine[]) => {
    const ids = new Set(lines.map((l) => l.markId));
    setGroups((prev) => prev.map((g) => ({ ...g, lines: g.lines.filter((l) => !ids.has(l.markId)) })));
    const r = await removeFromBillingAction(slug, [...ids]);
    if (r.error || !r.removed?.length) {
      putBack(lines);
      return toast(I.removeFailed, "error");
    }
    const gone = lines.filter((l) => r.removed!.includes(l.markId));
    // Anything already on an invoice by now stays where it was.
    putBack(lines.filter((l) => !r.removed!.includes(l.markId)));
    toast(gone.length === 1 ? I.removed : I.removedN.replace("{n}", String(gone.length)), "success", {
      label: I.undo,
      onClick: async () => {
        putBack(gone);
        const u = await restoreToBillingAction(slug, gone.map((l) => l.markId));
        if (u.error || !u.restored) {
          setGroups((prev) => prev.map((g) => ({ ...g, lines: g.lines.filter((l) => !gone.some((x) => x.markId === l.markId)) })));
          toast(I.restoreFailed, "error");
        } else toast(I.restored);
      },
    });
  };

  const group = (g: DeskGroup) => {
    const picked = g.lines.filter((l) => !unticked.has(l.markId));
    const pickedTotal = picked.reduce((n, l) => n + amountOf(l), 0);
    const showing = expanded.has(g.patientId);
    return (
      <li key={g.patientId} className="px-3 py-2.5 sm:px-5" data-desk-patient={g.patientId}>
        <div className="flex items-center gap-2.5">
          <Avatar name={g.name} size={28} />
          <button
            type="button"
            onClick={() => toggle(setExpanded, g.patientId)}
            aria-expanded={showing}
            aria-label={showing ? I.hideItems : I.showItems}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-ctl py-1 text-start hover:text-brand-700"
            data-desk-expand={g.patientId}
          >
            <span className="min-w-0">
              <span className="block truncate text-[14px] font-semibold">{g.name}</span>
              <span className="block truncate text-[12px] text-ink-500">
                {g.lines.length === 1 ? I.treatmentsOne : I.treatmentsN.replace("{n}", String(g.lines.length))} · {fmtDate(g.lastAt, tz, locale)}
              </span>
            </span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-ink-400 transition-transform ${showing ? "rotate-180" : ""}`} />
          </button>
          {picked.length > 0 ? (
            <Link
              href={`/c/${slug}/invoices/new?patient=${g.patientId}&marks=${picked.map((l) => l.markId).join(",")}`}
              className={buttonClass({ size: "sm", className: "shrink-0" })}
              data-desk-bill={g.patientId}
            >
              {I.billPicked.replace("{n}", String(picked.length)).replace("{total}", money(pickedTotal))}
            </Link>
          ) : (
            <span className={buttonClass({ size: "sm", variant: "outline", className: "pointer-events-none shrink-0 opacity-60" })}>{I.billNothing}</span>
          )}
          <button
            type="button"
            onClick={() => void remove(g.lines)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-500 hover:bg-danger-soft hover:text-danger"
            aria-label={I.removeAllFor.replace("{name}", g.name)}
            title={I.removeAllFor.replace("{name}", g.name)}
            data-desk-remove-all={g.patientId}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        {showing && (
          <ul className="mt-2 overflow-hidden rounded-ctl border border-line" data-desk-lines={g.patientId}>
            {g.lines.map((l) => {
              const on = !unticked.has(l.markId);
              const priceHref = l.chart === "aesthetic" ? (priceLinks.face ? `/c/${slug}/settings/face-prices` : null) : priceLinks.dental ? `/c/${slug}/settings/prices` : null;
              return (
                <li
                  key={l.markId}
                  className={`flex items-center gap-3 border-t border-line px-3 py-2 first:border-t-0 ${on ? "" : "bg-sunken"}`}
                  data-desk-line={l.markId}
                >
                  <input
                    type="checkbox"
                    className="h-4.5 w-4.5 shrink-0 accent-brand-600"
                    checked={on}
                    onChange={() => toggle(setUnticked, l.markId)}
                    aria-label={l.description}
                  />
                  <span className={`min-w-0 flex-1 ${on ? "" : "text-ink-500"}`}>
                    <span className="block text-[13px] font-medium" dir="auto">
                      {l.description}
                    </span>
                    {/* Which chart it came from, and who did it — under the words, so a phone gives the words the line. */}
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-500">
                      <span className="inline-flex h-[18px] items-center rounded-md border border-line-strong bg-sunken px-1.5 text-[11px] font-semibold text-ink-700">
                        {l.chart === "aesthetic" ? I.chartFace : I.chartDental}
                      </span>
                      {l.doctorName}
                    </span>
                  </span>
                  <span className="shrink-0 text-end">
                    {l.priced ? (
                      <span className={`text-[13.5px] font-semibold tnum ${on ? "" : "text-ink-500 line-through"}`}>{money(amountOf(l))}</span>
                    ) : (
                      <span className="block text-[12px] font-semibold text-st-pending">
                        {I.noPriceYet}
                        {priceHref && (
                          <Link href={priceHref} className="ms-1.5 text-brand-700 hover:underline">
                            {I.setPrice}
                          </Link>
                        )}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove([l])}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-500 hover:bg-danger-soft hover:text-danger"
                    aria-label={`${I.remove}: ${l.description}`}
                    title={I.remove}
                    data-desk-remove={l.markId}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
            <li className="border-t border-line px-3 py-2">
              <Link href={`/c/${slug}/patients/${g.patientId}?tab=invoices`} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline">
                {I.openFile}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </li>
          </ul>
        )}
      </li>
    );
  };

  return (
    <div data-ready-desk={live.length} data-ready-open={open === null ? undefined : open ? "1" : "0"}>
      <Card className="mb-4">
        {/* One line while minimised: what waits to be billed, and how much. */}
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={!!open}
          aria-label={open ? I.hideDesk : I.showDesk}
          className="flex w-full items-center gap-3 px-4 py-3 text-start sm:px-5"
          data-ready-toggle
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">{I.readyToBill}</span>
            {open && <span className="mt-0.5 block text-[13px] text-ink-500">{I.deskSub}</span>}
          </span>
          <span className="shrink-0 rounded-full bg-sunken px-3 py-1 text-[12.5px] font-semibold text-ink-700 tnum" data-desk-total={Math.round(total * 100) / 100}>
            {live.length === 1 ? I.deskPatientsOne : I.deskPatients.replace("{n}", String(live.length))} · {money(total)}
          </span>
          <ChevronDown className={`h-4.5 w-4.5 shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <>
            <ul className="divide-y divide-line border-t border-line">{(all ? live : live.slice(0, SHOWN)).map(group)}</ul>
            {live.length > SHOWN && !all && (
              <button type="button" onClick={() => setAll(true)} className="block w-full border-t border-line px-4 py-2.5 text-start text-[13px] font-medium text-brand-700 hover:bg-sunken sm:px-5">
                {I.showAllN.replace("{n}", String(live.length))}
              </button>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
