"use client";

/*
  Treatment prices: what each treatment on the dental chart costs.

  The dentist said each treatment has its price — each kind of crown its own.
  They are set here, once, and every treatment charted on a patient takes its
  price from here: the doctor never types one. A treatment can cost a price
  for the whole of it, a price per visit, or have both; which one a patient
  pays is chosen on that patient's treatment (Yamen, 2026-10-12). A price is a
  service: the invoice builder, the booking page and the chart read the same
  list, so the same cleaning never costs two different amounts. A treatment
  the clinic already sells as a service is linked to it rather than priced
  twice.

  Three people read this list, so every row says it three ways: the English
  the doctor charts in, the Arabic the reception works in, and the line the
  patient will read on the invoice. That last one is the service's name, and
  can be changed here.

  What the clinic charted with no price comes first. Priced from there, the
  treatments already charted take the price too.

  Saved as typed, when the box is left. An empty box means no price yet.
*/

import { useMemo, useState } from "react";
import { ChevronDown, Link2, Pencil, ReceiptText, TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, SearchInput } from "@/components/ui/input";
import { BUILT_IN, PROCEDURE_CATEGORIES, matchesQuery, type Treatment } from "@/lib/charts/dental/catalog";
import { PER_SESSION_BY_DEFAULT, PRICE_BY, invoiceLineText, variantName, type PriceRow, type PriceUnit } from "@/lib/charts/dental/pricing";
import { renameDentalPricesAction, saveDentalPriceAction } from "../services/actions";

export type DentalPrice = PriceRow;
export type LinkableService = { id: string; name: string; name_ar: string | null; price: string };
/** How often a treatment was charted, and how many of those carry no price. */
export type Usage = { used: number; unpriced: number };
/** A treatment, or a kind of it, charted with no price and with nothing on the list to price it. */
export type NeedsPrice = { key: string; variant: string | null; count: number };

type Filter = "all" | "priced" | "unpriced" | "used";

/** A price box: the figure as typed, saved when it is left. */
function PriceBox({ value, placeholder, label, hook, onSave }: { value: number | null; placeholder?: string; label: string; hook?: string; onSave: (v: number | null) => Promise<boolean> }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const commit = async () => {
    const v = text.trim() === "" ? null : Number(text);
    if (v !== null && (!Number.isFinite(v) || v < 0)) return;
    if (v === value) return;
    setSaving(true);
    const ok = await onSave(v);
    setSaving(false);
    if (!ok) setText(value == null ? "" : String(value));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      dir="ltr"
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => /^\d{0,7}(\.\d{0,3})?$/.test(e.target.value) && setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`h-9 w-24 rounded-ctl border bg-surface px-2 text-end text-base tnum focus:border-brand-600 focus:outline-none md:text-sm ${saving ? "border-brand-300" : "border-line"}`}
      data-price-box={hook ?? label}
    />
  );
}

/** Where a treatment is recorded, as an example for the invoice line: a tooth, an arch, the mouth. */
function sampleSite(tr: Treatment): string {
  if (tr.scope === "mouth") return "mouth";
  if (tr.scope === "arch") return "upper";
  if (tr.scope === "quadrant") return "Q1";
  return tr.category === "ortho" || tr.look === "veneer" ? "11" : "36";
}

export function DentalPrices({
  slug,
  currency,
  custom,
  prices: initial,
  services,
  usage,
  needs: initialNeeds,
}: {
  slug: string;
  currency: string;
  /** The clinic's own treatments, as the chart knows them. */
  custom: Treatment[];
  prices: DentalPrice[];
  /** The clinic's services not yet linked to a treatment: what a treatment can be "the same as". */
  services: LinkableService[];
  usage: Record<string, Usage>;
  needs: NeedsPrice[];
}) {
  const { t, locale } = useI18n();
  const S = t.services.dental;
  const { toast } = useToast();
  const [prices, setPrices] = useState<DentalPrice[]>(initial);
  const [free, setFree] = useState<LinkableService[]>(services);
  const [needs, setNeeds] = useState<NeedsPrice[]>(initialNeeds);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(() => new Set(["endodontic", "fixed", "implant", "preventive", "restorative"]));
  const [renaming, setRenaming] = useState<Treatment | null>(null);
  const [names, setNames] = useState<Record<string, { name: string; nameAr: string }>>({});
  const [busy, setBusy] = useState(false);

  const treatments = useMemo(() => [...BUILT_IN, ...custom].filter((tr) => tr.kind === "procedure"), [custom]);
  const byKey = useMemo(() => new Map(treatments.map((tr) => [tr.key, tr])), [treatments]);
  const priceOf = (key: string, variant: string | null, unit: PriceUnit) => prices.find((p) => p.chartKey === key && p.variant === variant && p.unit === unit) ?? null;
  const pricedKeys = new Set(prices.map((p) => p.chartKey));
  // How a price typed under "Needs a price" charges: the way the treatment starts.
  const firstUnit = (key: string): PriceUnit => (PER_SESSION_BY_DEFAULT.has(key) ? "session" : "item");
  // The doctor's name for it and the reception's, whichever the reader is.
  /*
    Treatments by their medical names, in English, whatever the page speaks —
    the words the doctor charts in (Yamen, 2026-10-12). The abbreviation and the
    Arabic name follow, smaller, for the reception.
  */
  const nameOf = (tr: Treatment) => tr.en;
  const otherName = (tr: Treatment) => [tr.abbr, tr.ar].filter(Boolean).join(" · ");

  const save = async (key: string, variant: string | null, price: number | null, unit: "item" | "session", link?: string): Promise<boolean> => {
    const r = await saveDentalPriceAction(slug, { key, variant, price, unit, linkServiceId: link ?? null });
    if (r.error) {
      toast(S.failed, "error");
      return false;
    }
    setPrices((prev) => [...prev.filter((p) => !(p.chartKey === key && p.variant === variant && p.unit === unit)), ...(r.row ? [r.row] : [])]);
    if (link) setFree((prev) => prev.filter((s) => s.id !== link));
    if (r.released) setFree((prev) => [...prev, r.released!]);
    if (r.row) {
      // Priced: what was waiting for this price is not waiting any more.
      setNeeds((prev) => prev.filter((n) => !(n.key === key && (variant === null || n.variant === variant))));
      if (r.priced) toast(S.pricedWaiting.replace("{n}", String(r.priced)));
    }
    return true;
  };

  const openRename = (tr: Treatment) => {
    const mine = prices.filter((p) => p.chartKey === tr.key);
    setNames(Object.fromEntries(mine.map((p) => [p.serviceId, { name: p.name, nameAr: p.nameAr ?? "" }])));
    setRenaming(tr);
  };
  const saveNames = async () => {
    const rows = Object.entries(names).map(([serviceId, v]) => ({ serviceId, name: v.name.trim(), nameAr: v.nameAr.trim() }));
    if (!rows.length || rows.some((r) => !r.name)) return;
    setBusy(true);
    const r = await renameDentalPricesAction(slug, rows);
    setBusy(false);
    if (r.error || !r.rows) {
      toast(S.failed, "error");
      return;
    }
    setPrices((prev) => prev.map((p) => {
      const u = r.rows!.find((x) => x.serviceId === p.serviceId);
      return u ? { ...p, name: u.name, nameAr: u.nameAr } : p;
    }));
    setRenaming(null);
    toast(S.namesSaved);
  };

  const keep = (tr: Treatment) => {
    if (!matchesQuery(tr, q)) return false;
    if (filter === "priced") return pricedKeys.has(tr.key);
    if (filter === "unpriced") return !pricedKeys.has(tr.key);
    if (filter === "used") return (usage[tr.key]?.used ?? 0) > 0;
    return true;
  };
  const groups = PROCEDURE_CATEGORIES.map((cat) => ({ cat, list: treatments.filter((tr) => tr.category === cat && keep(tr)) })).filter((g) => g.list.length);
  const priced = pricedKeys.size;
  const filters: [Filter, string][] = [
    ["all", S.filterAll],
    ["priced", S.filterPriced],
    ["unpriced", S.filterUnpriced],
    ["used", S.filterUsed],
  ];

  return (
    // The hook sits on a wrapper: Card passes on no data-* attribute.
    <div className="grid gap-4" data-dental-prices>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold">{S.title}</h2>
            <p className="mt-1 max-w-2xl text-[13px] text-ink-500">{S.sub}</p>
          </div>
          <span className="rounded-full bg-sunken px-2.5 py-1 text-[12px] font-semibold text-ink-500 tnum">{S.count.replace("{n}", String(priced))}</span>
        </div>
        {/* Who reads which name: said once, at the top, rather than on every row. */}
        <p className="mt-3 flex items-start gap-2 rounded-ctl bg-canvas px-3 py-2 text-[12.5px] text-ink-700">
          <ReceiptText className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
          {S.readers}
        </p>
      </Card>

      {/* What was charted with no price, first: the gaps are what the page is for. */}
      {needs.length > 0 && (
        <div data-needs-price={needs.length}>
          <Card className="border-st-pending/40 p-5">
            <h3 className="flex items-center gap-2 text-[15px] font-semibold">
              <TriangleAlert className="h-4 w-4 text-st-pending" />
              {S.needsTitle}
            </h3>
            <p className="mt-1 text-[13px] text-ink-500">{S.needsHint}</p>
            <ul className="mt-3 divide-y divide-line">
              {needs.map((n) => {
                const tr = byKey.get(n.key);
                if (!tr) return null;
                const vName = variantName(n.key, n.variant, "en");
                const label = vName ? `${nameOf(tr)} · ${vName}` : nameOf(tr);
                return (
                  <li key={`${n.key}:${n.variant ?? ""}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5" data-needs-row={`${n.key}:${n.variant ?? ""}`}>
                    <div className="min-w-[12rem] flex-1">
                      <div className="text-[14px] font-medium">
                        <bdi>{label}</bdi>
                      </div>
                      <div className="text-[12px] text-ink-500">
                        {otherName(tr)} · <span className="font-semibold text-st-pending">{S.unpricedN.replace("{n}", String(n.count))}</span>
                      </div>
                    </div>
                    <PriceBox value={null} label={label} hook={`needs:${n.key}:${n.variant ?? ""}`} onSave={(v) => (v == null ? Promise.resolve(true) : save(n.key, n.variant, v, firstUnit(n.key)))} />
                    <span className="text-[12px] text-ink-500">{currency}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
      )}

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SearchInput className="w-full sm:w-72" placeholder={S.search} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex flex-wrap gap-1">
            {filters.map(([f, label]) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                data-price-filter={f}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors duration-140 ${
                  filter === f ? "bg-brand-600 text-white" : "bg-ink-900/4 text-ink-500 hover:bg-ink-900/8 hover:text-ink-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          {groups.map(({ cat, list }) => {
            const isOpen = open.has(cat) || !!q || filter !== "all";
            return (
              <section key={cat} className="rounded-card border border-line" data-price-group={cat}>
                <button
                  type="button"
                  onClick={() => setOpen((prev) => {
                    const n = new Set(prev);
                    if (n.has(cat)) n.delete(cat);
                    else n.add(cat);
                    return n;
                  })}
                  className="flex w-full items-center justify-between gap-2 px-4 py-3 text-start"
                >
                  <span className="text-[14px] font-semibold">{t.dental.categories[cat]}</span>
                  <ChevronDown className={`h-4 w-4 text-ink-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
                {isOpen && (
                  <ul className="divide-y divide-line border-t border-line">
                    {list.map((tr) => {
                      const base = priceOf(tr.key, null, "item");
                      const baseVisit = priceOf(tr.key, null, "session");
                      const field = PRICE_BY[tr.key] ? tr.details?.find((d) => d.key === PRICE_BY[tr.key]) : undefined;
                      const name = nameOf(tr);
                      const use = usage[tr.key];
                      const mine = prices.filter((p) => p.chartKey === tr.key);
                      // The line the patient reads: the treatment's own price if it has one, else its first priced kind.
                      const shown = base ?? baseVisit ?? mine[0] ?? null;
                      // One price box: whole or per visit, for the treatment or one kind of it.
                      const box = (variant: string | null, unit: PriceUnit, label: string, hook: string, placeholder?: string) => (
                        <PriceBox
                          key={`${variant ?? ""}:${unit}`}
                          value={priceOf(tr.key, variant, unit)?.price ?? null}
                          placeholder={placeholder}
                          label={label}
                          hook={hook}
                          onSave={(p) => save(tr.key, variant, p, unit)}
                        />
                      );
                      const preview = shown
                        ? invoiceLineText(
                            { label: tr.en, labelAr: tr.ar, treatmentKey: tr.key, detail: shown.variant && field ? { [field.key]: shown.variant } : {}, site: sampleSite(tr) },
                            shown,
                            locale,
                            t.invoices.chartLine
                          )
                        : null;
                      return (
                        <li key={tr.key} className="grid gap-2 px-4 py-3" data-price-row={tr.key}>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <div className="min-w-[12rem] flex-1">
                              <div className="text-[14px] font-medium" data-price-name>
                                <bdi>{name}</bdi>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-ink-500">
                                <span dir="auto">{otherName(tr)}</span>
                                {use && use.used > 0 && <span className="tnum">· {S.usedN.replace("{n}", String(use.used))}</span>}
                              </div>
                            </div>
                            {/* Two prices: the whole treatment, and each visit — either, or both. */}
                            <label className="grid gap-1 text-[11.5px] font-semibold text-ink-500" data-price-col="item">
                              {S.whole}
                              <span className="flex items-center gap-1.5">
                                {box(null, "item", `${name} · ${S.whole}`, tr.en)}
                                <span className="text-[12px] font-normal">{currency}</span>
                              </span>
                            </label>
                            <label className="grid gap-1 text-[11.5px] font-semibold text-ink-500" data-price-col="session">
                              {S.perVisit}
                              <span className="flex items-center gap-1.5">
                                {box(null, "session", `${name} · ${S.perVisit}`, `${tr.en} · ${S.perSession}`)}
                                <span className="text-[12px] font-normal">{currency}</span>
                              </span>
                            </label>
                            {!base && free.length > 0 && (
                              <label className="flex items-center gap-1.5 self-end text-[12px] text-ink-500">
                                <Link2 className="h-3.5 w-3.5" />
                                <select
                                  value=""
                                  onChange={(e) => e.target.value && void save(tr.key, null, null, "item", e.target.value)}
                                  className="select-chevron h-9 max-w-[12rem] appearance-none rounded-ctl border border-line bg-surface ps-2.5 pe-8 text-[13px]"
                                  aria-label={S.sameAs}
                                  data-same-as={tr.key}
                                >
                                  <option value="">{S.sameAs}</option>
                                  {free.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {(locale === "ar" ? s.name_ar || s.name : s.name) + ` · ${Number(s.price)}`}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </div>
                          {/* Each kind of it — a material, a canal count — priced both ways too, in a small table. */}
                          {field && (
                            <div className="grid w-fit grid-cols-[minmax(7rem,auto)_6rem_6rem] items-center gap-x-3 gap-y-1.5 ps-0 text-[13px] sm:ps-4">
                              <span />
                              <span className="text-[11.5px] font-semibold text-ink-500">{S.whole}</span>
                              <span className="text-[11.5px] font-semibold text-ink-500">{S.perVisit}</span>
                              {field.options.map((o) => (
                                <div key={o.key} className="contents" data-price-variant={`${tr.key}:${o.key}`}>
                                  <bdi className="text-ink-700">{o.en}</bdi>
                                  {box(o.key, "item", `${name} · ${o.en}`, `${tr.en} · ${o.en}`, base ? String(base.price) : "—")}
                                  {box(o.key, "session", `${name} · ${o.en} · ${S.perSession}`, `${tr.en} · ${o.en} · ${S.perSession}`, baseVisit ? String(baseVisit.price) : "—")}
                                </div>
                              ))}
                              <span className="col-span-3 text-[12px] text-ink-400">{S.variantHint}</span>
                            </div>
                          )}
                          {/* What the patient will read, and the way to change it. */}
                          {preview && (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]" data-invoice-preview={tr.key}>
                              <span className="text-ink-500">{S.onInvoice}:</span>
                              <span className="font-medium text-ink-900" dir="auto">«{preview}»</span>
                              <button type="button" onClick={() => openRename(tr)} className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline" data-rename-price={tr.key}>
                                <Pencil className="h-3.5 w-3.5" />
                                {S.rename}
                              </button>
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
      </Card>

      {/* The names on the invoice, in both languages, for each price of the treatment. */}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title={S.rename}>
        {renaming && (
          <div className="grid gap-4" data-rename-dialog>
            <p className="text-[13px] text-ink-500">{S.renameHint}</p>
            {prices
              .filter((p) => p.chartKey === renaming.key)
              .map((p) => {
                const v = names[p.serviceId] ?? { name: p.name, nameAr: p.nameAr ?? "" };
                const kind = variantName(renaming.key, p.variant, "en");
                const title = [nameOf(renaming), kind, p.unit === "session" ? S.perSession : null].filter(Boolean).join(" · ");
                return (
                  <div key={p.serviceId} className="grid gap-2 rounded-ctl border border-line p-3">
                    <div className="text-[13px] font-semibold">{title}</div>
                    <label className="grid gap-1 text-[12px] font-semibold text-ink-500">
                      {S.nameEn}
                      <Input dir="ltr" value={v.name} maxLength={80} onChange={(e) => setNames((prev) => ({ ...prev, [p.serviceId]: { ...v, name: e.target.value } }))} />
                    </label>
                    <label className="grid gap-1 text-[12px] font-semibold text-ink-500">
                      {S.nameAr}
                      <Input dir="rtl" value={v.nameAr} maxLength={80} onChange={(e) => setNames((prev) => ({ ...prev, [p.serviceId]: { ...v, nameAr: e.target.value } }))} />
                    </label>
                  </div>
                );
              })}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRenaming(null)}>
                {t.common.cancel}
              </Button>
              <Button onClick={() => void saveNames()} loading={busy} data-save-names>
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
