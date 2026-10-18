"use client";

/*
  The clinic's dental labs, each with its prices.

  A lab is a name, a phone, and whether it is the clinic's own. Its prices are
  per treatment and per kind — one lab's zirconia crown is not another's —
  and what a treatment sent there starts at (it can be changed on the case).
  Saved as typed, when a box is left, like Treatment prices.
*/

import { useMemo, useState, useTransition } from "react";
import { ChevronDown, FlaskConical, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Toggle } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { BUILT_IN, type Treatment } from "@/lib/charts/dental/catalog";
import { PRICE_BY } from "@/lib/charts/dental/pricing";
import { LAB_TREATMENTS, type LabPrice, type LabRow } from "@/lib/charts/dental/labs";
import { PriceBox } from "../prices/dental-prices";
import { archiveLabAction, saveLabAction, saveLabPriceAction } from "./actions";

type Draft = { id: string | null; name: string; phone: string; inHouse: boolean; note: string };
const blank: Draft = { id: null, name: "", phone: "", inHouse: false, note: "" };

export function DentalLabs({
  slug,
  currency,
  labs: initialLabs,
  prices: initialPrices,
  custom,
  used,
}: {
  slug: string;
  currency: string;
  labs: LabRow[];
  prices: LabPrice[];
  custom: Treatment[];
  used: Record<string, number>;
}) {
  const { t } = useI18n();
  const S = t.services.labs;
  const { toast } = useToast();
  const [labs, setLabs] = useState<LabRow[]>(initialLabs);
  const [prices, setPrices] = useState<LabPrice[]>(initialPrices);
  const [draft, setDraft] = useState<Draft | null>(initialLabs.length ? null : blank);
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // What a lab makes: the chart's lab treatments, then the clinic's own.
  const treatments = useMemo(
    () => [...BUILT_IN.filter((tr) => LAB_TREATMENTS.has(tr.key)), ...custom.filter((tr) => tr.kind === "procedure")],
    [custom]
  );
  const costOf = (labId: string, key: string, variant: string | null) =>
    prices.find((p) => p.labId === labId && p.chartKey === key && p.variant === variant)?.cost ?? null;

  const saveLab = () =>
    start(async () => {
      if (!draft || !draft.name.trim()) return;
      const r = await saveLabAction(slug, draft);
      if (r.error || !r.lab) {
        toast(S.failed, "error");
        return;
      }
      setLabs((prev) => (prev.some((l) => l.id === r.lab!.id) ? prev.map((l) => (l.id === r.lab!.id ? r.lab! : l)) : [...prev, r.lab!]));
      if (!draft.id) setOpen(r.lab.id);
      setDraft(null);
      toast(S.saved);
    });

  const archive = (lab: LabRow) =>
    start(async () => {
      const r = await archiveLabAction(slug, lab.id);
      if (r.error) {
        toast(S.failed, "error");
        return;
      }
      setLabs((prev) => prev.filter((l) => l.id !== lab.id));
    });

  const savePrice = async (labId: string, key: string, variant: string | null, cost: number | null): Promise<boolean> => {
    const r = await saveLabPriceAction(slug, { labId, key, variant, cost });
    if (r.error) {
      toast(S.failed, "error");
      return false;
    }
    setPrices((prev) => [...prev.filter((p) => !(p.labId === labId && p.chartKey === key && p.variant === variant)), ...(r.price ? [r.price] : [])]);
    return true;
  };

  return (
    <div className="grid gap-4" data-dental-labs>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold">{S.title}</h2>
            <p className="mt-1 max-w-2xl text-[13px] text-ink-500">{S.sub}</p>
          </div>
          {!draft && (
            <Button variant="soft" size="sm" onClick={() => setDraft(blank)} data-lab-new>
              <Plus className="h-4 w-4" />
              {S.add}
            </Button>
          )}
        </div>
      </Card>

      {draft && (
        <Card className="p-5">
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveLab();
            }}
            data-lab-editor
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={S.name} required>
                <Input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus data-lab-name />
              </Field>
              <Field label={S.phone} hint={t.common.optional}>
                <Input value={draft.phone} maxLength={40} dir="ltr" onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              </Field>
            </div>
            <label className="flex items-center gap-2.5">
              <Toggle checked={draft.inHouse} onChange={(v) => setDraft({ ...draft, inHouse: v })} />
              <span className="text-[13px] font-medium">{S.inHouse}</span>
            </label>
            <p className="text-[12px] text-ink-500">{draft.inHouse ? S.inHouseHint : S.outsideHint}</p>
            <Field label={S.note} hint={t.common.optional}>
              <Input value={draft.note} maxLength={500} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              {labs.length > 0 && (
                <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                  {t.common.cancel}
                </Button>
              )}
              <Button type="submit" loading={pending} disabled={!draft.name.trim()} data-lab-save>
                {t.common.save}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {labs.length === 0 && !draft && (
        <Card className="p-5">
          <EmptyState icon={<FlaskConical className="h-6 w-6" />} title={S.none} body={S.noneBody} />
        </Card>
      )}

      {labs.map((lab) => {
        const isOpen = open === lab.id;
        const set = prices.filter((p) => p.labId === lab.id).length;
        return (
          <section key={lab.id} className="min-w-0 rounded-card border border-line bg-surface" data-lab={lab.id}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <button type="button" onClick={() => setOpen(isOpen ? null : lab.id)} className="flex min-w-0 flex-1 items-center gap-2 text-start">
                <FlaskConical className="h-4 w-4 shrink-0 text-ink-400" />
                <span className="truncate text-[15px] font-semibold">{lab.name}</span>
                {lab.inHouse && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11.5px] font-semibold text-brand-700">{S.inHouseTag}</span>}
                <span className="text-[12px] text-ink-500 tnum">
                  {S.pricesN.replace("{n}", String(set))}
                  {used[lab.id] ? ` · ${S.usedN.replace("{n}", String(used[lab.id]))}` : ""}
                </span>
                <ChevronDown className={`ms-auto h-4 w-4 shrink-0 text-ink-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setDraft({ id: lab.id, name: lab.name, phone: lab.phone, inHouse: lab.inHouse, note: lab.note })}>
                  {S.edit}
                </Button>
                <Button size="sm" variant="outline" onClick={() => archive(lab)} data-lab-archive={lab.id}>
                  {S.archive}
                </Button>
              </div>
            </div>
            {isOpen && (
              <ul className="divide-y divide-line border-t border-line" data-lab-prices={lab.id}>
                <li className="px-4 py-2 text-[12px] text-ink-500">{S.pricesHint}</li>
                {treatments.map((tr) => {
                  const field = PRICE_BY[tr.key] ? tr.details?.find((d) => d.key === PRICE_BY[tr.key]) : undefined;
                  const base = costOf(lab.id, tr.key, null);
                  return (
                    <li key={tr.key} className="grid gap-2 px-4 py-2.5" data-lab-price-row={tr.key}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <div className="min-w-[10rem] flex-1 text-[14px] font-medium">
                          <bdi>{tr.en}</bdi>
                          <span className="ms-2 text-[12px] font-normal text-ink-500" dir="auto">
                            {tr.ar}
                          </span>
                        </div>
                        <span className="flex items-center gap-1.5">
                          <PriceBox value={base} label={`${lab.name} · ${tr.en}`} hook={`${lab.id}:${tr.key}`} onSave={(v) => savePrice(lab.id, tr.key, null, v)} />
                          <span className="text-[12px] text-ink-500">{currency}</span>
                        </span>
                      </div>
                      {field && (
                        <div className="grid w-full grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-x-2 gap-y-1.5 text-[13px] sm:w-fit sm:grid-cols-[minmax(7rem,auto)_6rem] sm:gap-x-3 sm:ps-4">
                          {field.options.map((o) => (
                            <div key={o.key} className="contents" data-lab-price-variant={`${tr.key}:${o.key}`}>
                              <bdi className="min-w-0 break-words text-ink-700">{o.en}</bdi>
                              <PriceBox
                                value={costOf(lab.id, tr.key, o.key)}
                                placeholder={base == null ? "—" : String(base)}
                                label={`${lab.name} · ${tr.en} · ${o.en}`}
                                hook={`${lab.id}:${tr.key}:${o.key}`}
                                onSave={(v) => savePrice(lab.id, tr.key, o.key, v)}
                                className="w-full"
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
