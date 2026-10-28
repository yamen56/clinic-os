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

  Each item is ticked; untick what is not going on this bill, and Bill opens
  the invoice with what is ticked. Remove takes an item off the list for good
  (removeFromBillingAction): it stays on the chart, at no charge.
*/

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";
import { buttonClass } from "@/components/ui/button-class";
import { ConfirmDialog } from "@/components/ui/modal";
import { fmtDate, fmtMoney } from "@/lib/dates";
import type { DeskLine } from "@/lib/charts/dental/billing-server";
import { removeFromBillingAction } from "./actions";

export type DeskGroup = { patientId: string; name: string; lastAt: string; lines: DeskLine[] };

const SHOWN = 5;
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
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<DeskLine | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);

  const money = (n: number) => fmtMoney(n, currency, locale);
  const live = useMemo(() => groups.filter((g) => g.lines.length > 0), [groups]);
  const total = live.reduce((n, g) => n + g.lines.reduce((m, l) => m + amountOf(l), 0), 0);
  if (!live.length) return null;

  const toggle = (id: string) =>
    setUnticked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    const r = await removeFromBillingAction(slug, removing.markId);
    setBusy(false);
    if (r.error) {
      toast(I.removeFailed, "error");
    } else {
      const gone = removing.markId;
      setGroups((prev) => prev.map((g) => ({ ...g, lines: g.lines.filter((l) => l.markId !== gone) })));
      toast(I.removed);
    }
    setRemoving(null);
  };

  const group = (g: DeskGroup) => {
    const picked = g.lines.filter((l) => !unticked.has(l.markId));
    const pickedTotal = picked.reduce((n, l) => n + amountOf(l), 0);
    return (
      <li key={g.patientId} className="px-4 py-3.5 sm:px-5" data-desk-patient={g.patientId}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Avatar name={g.name} size={32} />
          <div className="min-w-0 flex-1">
            <Link href={`/c/${slug}/patients/${g.patientId}?tab=invoices`} className="inline-flex items-center gap-1 text-[14px] font-semibold hover:text-brand-700">
              {g.name}
              <ArrowUpRight className="h-3.5 w-3.5 text-ink-400" aria-label={I.openFile} />
            </Link>
            <div className="text-[12px] text-ink-500">
              {g.lines.length === 1 ? I.treatmentsOne : I.treatmentsN.replace("{n}", String(g.lines.length))} · {fmtDate(g.lastAt, tz, locale)}
            </div>
          </div>
          {picked.length > 0 ? (
            <Link
              href={`/c/${slug}/invoices/new?patient=${g.patientId}&marks=${picked.map((l) => l.markId).join(",")}`}
              className={buttonClass({ size: "sm" })}
              data-desk-bill={g.patientId}
            >
              {I.billPicked.replace("{n}", String(picked.length)).replace("{total}", money(pickedTotal))}
            </Link>
          ) : (
            <span className={buttonClass({ size: "sm", variant: "outline", className: "pointer-events-none opacity-60" })}>{I.billNothing}</span>
          )}
        </div>
        <ul className="mt-2.5 overflow-hidden rounded-ctl border border-line">
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
                  onChange={() => toggle(l.markId)}
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
                  onClick={() => setRemoving(l)}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-500 hover:bg-danger-soft hover:text-danger"
                  aria-label={`${I.remove}: ${l.description}`}
                  title={I.remove}
                  data-desk-remove={l.markId}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      </li>
    );
  };

  return (
    <div data-ready-desk={live.length}>
      <Card className="mb-4">
        <div className="flex flex-wrap items-start justify-between gap-2 px-4 pt-3.5 pb-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">{I.readyToBill}</h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{I.deskSub}</p>
          </div>
          <span className="rounded-full bg-sunken px-3 py-1 text-[12.5px] font-semibold text-ink-700 tnum" data-desk-total={Math.round(total * 100) / 100}>
            {live.length === 1 ? I.deskPatientsOne : I.deskPatients.replace("{n}", String(live.length))} · {money(total)}
          </span>
        </div>
        <ul className="divide-y divide-line border-t border-line">{(all ? live : live.slice(0, SHOWN)).map(group)}</ul>
        {live.length > SHOWN && !all && (
          <button type="button" onClick={() => setAll(true)} className="block w-full border-t border-line px-4 py-2.5 text-start text-[13px] font-medium text-brand-700 hover:bg-sunken sm:px-5">
            {I.showAllN.replace("{n}", String(live.length))}
          </button>
        )}
      </Card>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        title={I.removeTitle}
        body={removing ? I.removeBody.replace("{line}", removing.description) : ""}
        confirmLabel={I.remove}
        cancelLabel={t.common.cancel}
        loading={busy}
      />
    </div>
  );
}
