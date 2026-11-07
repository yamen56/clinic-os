"use client";

/*
  Products and stock, as the doctor and the desk use them.

  A product is a card: what it is, who sells it, the treatments it is used in,
  what is on hand and the batch the next treatment takes from. Running low,
  run out, expiring and used with none on hand say so on the card and at the
  top. Receive stock puts a delivery on hand and records what it cost; Correct
  sets a batch's count right, with the reason. Each answer brings the lists
  back as they now stand.

  Deleting is one tap with an Undo on the toast, no confirm box. The row leaves
  on the tap and comes back if the server says no.
*/

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Building2, ChevronDown, History, PackagePlus, Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card, PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
import { fmtDateOnly, fmtMoney } from "@/lib/dates";
import { FACE_TREATMENTS, FACE_TREATMENT_BY_KEY, productAmount } from "@/lib/charts/face/catalog";
import { EXPIRY_WARN_DAYS, PRODUCT_UNITS, needsRestock, type Company, type ProductUnit, type StockBatch, type StockMove, type StockProduct } from "@/lib/charts/face/stock";
import { FamilyTag } from "@/components/charts/face/family-tag";
import {
  adjustStockAction,
  deleteBatchAction,
  deleteCompanyAction,
  deleteProductAction,
  productHistoryAction,
  receiveStockAction,
  restoreBatchAction,
  restoreCompanyAction,
  restoreProductAction,
  saveCompanyAction,
  saveProductAction,
  undoAdjustAction,
} from "./actions";

type Answer = { products?: StockProduct[]; companies?: Company[]; error?: string; outcome?: "deleted" | "archived"; expenseKept?: boolean; moveId?: string };

const num = (s: string) => (s.trim() === "" ? null : Number(s));
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function StockClient({
  slug,
  currency,
  today,
  products: initialProducts,
  companies: initialCompanies,
  canPatients,
}: {
  slug: string;
  currency: string;
  today: string;
  products: StockProduct[];
  companies: Company[];
  canPatients: boolean;
}) {
  const { t, locale } = useI18n();
  const S = t.stock;
  const { toast } = useToast();
  const [products, setProducts] = useState(initialProducts);
  const [companies, setCompanies] = useState(initialCompanies);
  const [editing, setEditing] = useState<StockProduct | "new" | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<{ product: StockProduct; batch: StockBatch } | null>(null);
  const [companiesOpen, setCompaniesOpen] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<StockProduct | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const failure = (error: string) => (S.errors as Record<string, string>)[error] ?? S.failed;

  const apply = (r: Answer, done: string | null, undo?: () => void) => {
    if (r.error) {
      toast(failure(r.error), "error");
      return false;
    }
    if (r.products) setProducts(r.products);
    if (r.companies) setCompanies(r.companies);
    if (done) toast(done, "success", undo ? { label: S.undo, onClick: undo } : undefined);
    return true;
  };

  const removeProduct = async (p: StockProduct) => {
    const before = products;
    setProducts(before.filter((x) => x.id !== p.id));
    const r = await deleteProductAction(slug, p.id);
    if (r.error) setProducts(before);
    apply(r, (r.outcome === "archived" ? S.archivedToast : S.deleted).replace("{name}", p.name), async () => {
      apply(await restoreProductAction(slug, p.id), S.restored);
    });
  };

  const removeBatch = async (p: StockProduct, b: StockBatch) => {
    const before = products;
    setProducts(before.map((x) => (x.id === p.id ? { ...x, batches: x.batches.filter((y) => y.id !== b.id) } : x)));
    const r = await deleteBatchAction(slug, b.id);
    if (r.error) setProducts(before);
    apply(r, r.expenseKept ? S.deliveryDeletedKept : S.deliveryDeleted, async () => {
      apply(await restoreBatchAction(slug, b.id), S.restored);
    });
  };

  const removeCompany = async (c: Company) => {
    const before = companies;
    setCompanies(before.filter((x) => x.id !== c.id));
    const r = await deleteCompanyAction(slug, c.id);
    if (r.error) setCompanies(before);
    apply(r, (r.outcome === "archived" ? S.archivedToast : S.deleted).replace("{name}", c.name), async () => {
      apply(await restoreCompanyAction(slug, c.id), S.restored);
    });
  };

  const soon = addDays(today, EXPIRY_WARN_DAYS);
  const state = (p: StockProduct) => ({
    out: p.active && p.usable <= 0,
    owed: p.onHand < 0 ? -p.onHand : 0,
    low: p.active && p.usable > 0 && p.lowStock != null && p.usable <= p.lowStock,
    expiring: p.batches.filter((b) => b.onHand > 0 && !b.expired && b.expiresOn && b.expiresOn <= soon).length,
  });
  const alerts = useMemo(() => {
    const all = products.map(state);
    return { low: products.filter(needsRestock).length, expiring: all.reduce((n, x) => n + x.expiring, 0), owed: all.filter((x) => x.owed > 0).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `state` reads only `soon`, which follows `today`
  }, [products, soon]);
  const inUse = products.filter((p) => p.active);
  const archived = products.filter((p) => !p.active);

  const amount = (u: ProductUnit, n: number) => productAmount(u, n, locale);
  const money = (n: number) => fmtMoney(n, currency, locale);

  return (
    <div data-stock>
      <PageHeader
        title={S.title}
        sub={S.sub}
        action={
          <>
            <Button variant="outline" onClick={() => setCompaniesOpen(true)}>
              <Building2 className="h-4 w-4" />
              {S.companies}
            </Button>
            <Button variant="outline" onClick={() => setEditing("new")} data-stock-new-product>
              <Plus className="h-4 w-4" />
              {S.newProduct}
            </Button>
            <Button onClick={() => setReceiving(products.find((p) => p.active)?.id ?? "")} disabled={!products.some((p) => p.active)} data-stock-receive>
              <PackagePlus className="h-4 w-4" />
              {S.receive}
            </Button>
          </>
        }
      />

      {(alerts.low > 0 || alerts.expiring > 0 || alerts.owed > 0) && (
        <div className="mb-4 flex flex-wrap gap-2" data-stock-alerts>
          {alerts.low > 0 && <span className="rounded-full bg-st-noshow-soft px-3 py-1 text-[12.5px] font-semibold text-ink-900">{S.alerts.low.replace("{n}", String(alerts.low))}</span>}
          {alerts.expiring > 0 && (
            <span className="rounded-full bg-st-noshow-soft px-3 py-1 text-[12.5px] font-semibold text-ink-900">{S.alerts.expiring.replace("{n}", String(alerts.expiring))}</span>
          )}
          {alerts.owed > 0 && <span className="rounded-full bg-danger-soft px-3 py-1 text-[12.5px] font-semibold text-danger">{S.alerts.owed.replace("{n}", String(alerts.owed))}</span>}
        </div>
      )}

      {inUse.length === 0 ? (
        <Card className="p-6 text-[14px] text-ink-500">{S.empty}</Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {inUse.map((p) => {
            const st = state(p);
            const shown = open.has(p.id);
            return (
              <Card key={p.id} className="p-4">
                <div data-stock-product={p.id}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[15px] font-semibold" dir="auto">
                        {p.name}
                      </div>
                      <div className="text-[12.5px] text-ink-500">{p.company ?? S.product.noCompany}</div>
                    </div>
                    <div className="text-end">
                      <div className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">{S.onHand}</div>
                      <div className={`text-[20px] font-bold tnum ${st.out ? "text-danger" : ""}`} data-stock-on-hand={p.onHand}>
                        {amount(p.unit, Math.max(0, p.onHand))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.treatments.length ? (
                      p.treatments.map((k) => {
                        const tr = FACE_TREATMENT_BY_KEY.get(k);
                        return tr ? <FamilyTag key={k} family={tr.family} label={tr.en} /> : null;
                      })
                    ) : (
                      <span className="text-[12px] text-ink-500">{S.nothingUsedIn}</span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                    {p.next && (
                      <span className="text-ink-700">
                        {p.next.lot
                          ? S.next.replace("{lot}", p.next.lot).replace("{date}", p.next.expiresOn ? fmtDateOnly(p.next.expiresOn, locale) : S.noExpiry)
                          : S.nextNoLot.replace("{date}", p.next.expiresOn ? fmtDateOnly(p.next.expiresOn, locale) : S.noExpiry)}
                      </span>
                    )}
                    {st.out && <span className="font-semibold text-danger">{S.out}</span>}
                    {st.low && <span className="font-semibold text-ink-900">{S.low}</span>}
                    {st.expiring > 0 && <span className="font-semibold text-ink-900">{S.expiring}</span>}
                    {p.expired > 0 && <span className="font-semibold text-danger" data-stock-expired={p.expired}>{S.expiredOnHand.replace("{n}", amount(p.unit, p.expired))}</span>}
                    {st.owed > 0 && <span className="font-semibold text-danger">{S.owed.replace("{n}", amount(p.unit, st.owed))}</span>}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => setReceiving(p.id)} disabled={!p.active}>
                      {S.receive}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                      {S.edit}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setHistory(p)} data-stock-history>
                      <History className="h-3.5 w-3.5" />
                      {S.history}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={S.delete} onClick={() => void removeProduct(p)} data-stock-delete>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    {p.batches.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setOpen((prev) => {
                            const n = new Set(prev);
                            if (n.has(p.id)) n.delete(p.id);
                            else n.add(p.id);
                            return n;
                          })
                        }
                        className="ms-auto inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline"
                      >
                        {shown ? S.hideBatches : S.showBatches.replace("{n}", String(p.batches.length))}
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${shown ? "rotate-180" : ""}`} />
                      </button>
                    )}
                  </div>
                  {shown && (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-[12.5px]">
                        <thead>
                          <tr className="text-start text-ink-500">
                            <th className="px-2 py-1 text-start font-semibold">{S.lot}</th>
                            <th className="px-2 py-1 text-start font-semibold">{S.expires}</th>
                            <th className="px-2 py-1 text-end font-semibold">{S.received}</th>
                            <th className="px-2 py-1 text-end font-semibold">{S.left}</th>
                            <th className="px-2 py-1 text-end font-semibold">{S.unitCost}</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {p.batches.map((b) => {
                            const expired = !!b.expiresOn && b.expiresOn < today;
                            return (
                              <tr key={b.id} data-stock-batch={b.id}>
                                <td className="px-2 py-1.5">
                                  {/* A lot is Latin whatever the page: isolated, so it does not run into the date beside it. */}
                                  {b.lot ? <bdi>{b.lot}</bdi> : <span className="text-ink-500">{S.noLot}</span>}
                                </td>
                                <td className={`px-2 py-1.5 tnum ${expired ? "font-semibold text-danger" : ""}`}>
                                  {b.expiresOn ? fmtDateOnly(b.expiresOn, locale) : "—"}
                                  {expired && ` · ${S.expired}`}
                                </td>
                                <td className="px-2 py-1.5 text-end tnum">{amount(p.unit, b.qty)}</td>
                                <td className="px-2 py-1.5 text-end font-semibold tnum">{amount(p.unit, b.onHand)}</td>
                                <td className="px-2 py-1.5 text-end tnum">{money(b.unitCost)}</td>
                                <td className="px-2 py-1.5 text-end">
                                  <span className="inline-flex items-center gap-3">
                                    <button type="button" onClick={() => setAdjusting({ product: p, batch: b })} className="text-[12px] font-semibold text-brand-700 hover:underline">
                                      {S.adjust}
                                    </button>
                                    {b.untouched && (
                                      <button type="button" aria-label={S.delete} onClick={() => void removeBatch(p, b)} className="text-ink-400 hover:text-danger" data-batch-delete>
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {archived.length > 0 && (
        <div className="mt-4" data-stock-archived>
          <button
            type="button"
            onClick={() => setArchivedOpen((v) => !v)}
            className="inline-flex min-h-10 items-center gap-1 text-[13px] font-semibold text-ink-700 hover:text-ink-900"
          >
            {S.archived.replace("{n}", String(archived.length))}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${archivedOpen ? "rotate-180" : ""}`} />
          </button>
          {archivedOpen && (
            <Card className="mt-2">
              <ul className="divide-y divide-line">
                {archived.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-stock-archived-product={p.id}>
                    <span className="min-w-0 flex-1 text-[14px]" dir="auto">
                      {p.name}
                      {p.company && <span className="ms-2 text-[12.5px] text-ink-500">{p.company}</span>}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setHistory(p)}>
                      {S.history}
                    </Button>
                    <Button size="sm" variant="outline" onClick={async () => apply(await restoreProductAction(slug, p.id), S.restored)} data-stock-restore>
                      {S.restore}
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {editing && (
        <ProductForm
          product={editing === "new" ? null : editing}
          companies={companies}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            const r = await saveProductAction(slug, data);
            if (apply(r, S.saved)) setEditing(null);
          }}
        />
      )}
      {receiving !== null && (
        <ReceiveForm
          products={products.filter((p) => p.active)}
          initial={receiving}
          currency={currency}
          today={today}
          onClose={() => setReceiving(null)}
          onSave={async (data) => {
            const r = await receiveStockAction(slug, data);
            if (apply(r, S.receiveForm.done)) setReceiving(null);
          }}
        />
      )}
      {adjusting && (
        <AdjustForm
          product={adjusting.product}
          batch={adjusting.batch}
          onClose={() => setAdjusting(null)}
          onSave={async (data) => {
            const r = await adjustStockAction(slug, data);
            const undo = r.moveId
              ? async () => {
                  apply(await undoAdjustAction(slug, r.moveId!), S.restored);
                }
              : undefined;
            if (apply(r, S.adjustForm.done, undo)) setAdjusting(null);
          }}
        />
      )}
      <CompaniesForm
        open={companiesOpen}
        companies={companies}
        onClose={() => setCompaniesOpen(false)}
        onSave={async (data) => apply(await saveCompanyAction(slug, data), S.saved)}
        onDelete={(c) => void removeCompany(c)}
        onRestore={async (c) => {
          apply(await restoreCompanyAction(slug, c.id), S.restored);
        }}
      />
      {history && <HistoryList slug={slug} product={history} canPatients={canPatients} onClose={() => setHistory(null)} />}
    </div>
  );
}

/** Everything that happened to a product, newest first, each line pointing at the patient it went to. */
function HistoryList({ slug, product, canPatients, onClose }: { slug: string; product: StockProduct; canPatients: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const S = t.stock;
  const [moves, setMoves] = useState<StockMove[] | null>(null);

  useEffect(() => {
    let live = true;
    void productHistoryAction(slug, product.id).then((r) => {
      if (live) setMoves(r.moves ?? []);
    });
    return () => {
      live = false;
    };
  }, [slug, product.id]);

  return (
    <Modal open onClose={onClose} title={S.historyTitle.replace("{name}", product.name)} wide>
      {moves === null ? (
        <p className="py-6 text-center text-[13px] text-ink-500">…</p>
      ) : moves.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-500">{S.historyEmpty}</p>
      ) : (
        <ul className="divide-y divide-line" data-stock-moves>
          {moves.map((m) => (
            <li key={m.id} className="flex items-start gap-3 py-2 text-[13px]" data-stock-move={m.kind}>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{S.moves[m.kind]}</span>
                {m.lot && <bdi className="ms-2 text-ink-500">{m.lot}</bdi>}
                {m.treatment && <span className="ms-2 text-ink-500">{m.treatment}</span>}
                <span className="block text-[12px] text-ink-500">
                  {fmtDateOnly(m.at.slice(0, 10), locale)}
                  {m.by && ` · ${m.by}`}
                  {m.reason && ` · ${m.reason}`}
                </span>
                {canPatients && m.patient && (
                  <Link href={`/c/${slug}/patients/${m.patient.id}`} className="block text-[12px] font-semibold text-brand-700 hover:underline" dir="auto">
                    {m.patient.name}
                  </Link>
                )}
              </span>
              <span className={`shrink-0 font-semibold tnum ${m.qty < 0 ? "text-ink-700" : "text-ok"}`} dir="ltr">
                {m.qty > 0 ? "+" : "−"}
                {productAmount(product.unit, Math.abs(m.qty), locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ProductForm({
  product,
  companies,
  onClose,
  onSave,
}: {
  product: StockProduct | null;
  companies: Company[];
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const S = t.stock;
  const P = S.product;
  const [name, setName] = useState(product?.name ?? "");
  const [companyId, setCompanyId] = useState(product?.companyId ?? "");
  const [treatments, setTreatments] = useState<string[]>(product?.treatments ?? []);
  const [unit, setUnit] = useState<ProductUnit>(product?.unit ?? "u");
  const [packSize, setPackSize] = useState(String(product?.packSize ?? 1));
  const [lowStock, setLowStock] = useState(product?.lowStock == null ? "" : String(product.lowStock));
  const [lastCost, setLastCost] = useState(product?.lastCost == null ? "" : String(product.lastCost));
  const [active, setActive] = useState(product?.active ?? true);
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && Number(packSize) > 0;

  const submit = async () => {
    setBusy(true);
    await onSave({
      id: product?.id ?? null,
      name: name.trim(),
      companyId: companyId || null,
      treatments,
      unit,
      packSize: Number(packSize),
      lowStock: num(lowStock),
      lastCost: num(lastCost),
      active,
    });
    setBusy(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={product ? P.titleEdit : P.titleNew}
      wide
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {S.cancel}
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!valid} data-product-save>
            {S.save}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={P.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={P.namePlaceholder} maxLength={80} dir="auto" data-product-name />
        </Field>
        <Field label={P.company}>
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} data-product-company>
            <option value="">{P.noCompany}</option>
            {companies
              .filter((c) => c.active || c.id === companyId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={P.unit} hint={product?.everStocked ? P.unitLocked : undefined}>
          <Select value={unit} onChange={(e) => setUnit(e.target.value as ProductUnit)} disabled={!!product?.everStocked} data-product-unit>
            {PRODUCT_UNITS.map((u) => (
              <option key={u} value={u}>
                {P.units[u]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={P.packSize} hint={P.packSizeHint}>
          <Input type="text" inputMode="decimal" value={packSize} onChange={(e) => setPackSize(e.target.value)} dir="ltr" data-product-pack />
        </Field>
        <Field label={P.lowStock} hint={P.lowStockHint}>
          <Input type="text" inputMode="decimal" value={lowStock} onChange={(e) => setLowStock(e.target.value)} dir="ltr" />
        </Field>
        <Field label={P.lastCost} hint={P.lastCostHint}>
          <Input type="text" inputMode="decimal" value={lastCost} onChange={(e) => setLastCost(e.target.value)} dir="ltr" data-product-cost />
        </Field>
      </div>
      <div className="mt-4">
        <div className="text-[13px] font-semibold text-ink-900">{P.treatments}</div>
        <div className="text-xs text-ink-500">{P.treatmentsHint}</div>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2" dir="ltr">
          {FACE_TREATMENTS.map((x) => (
            <label key={x.key} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-600"
                checked={treatments.includes(x.key)}
                onChange={(e) => setTreatments((prev) => (e.target.checked ? [...prev, x.key] : prev.filter((k) => k !== x.key)))}
                data-product-treatment={x.key}
              />
              {x.en}
            </label>
          ))}
        </div>
      </div>
      {product && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="text-[13px] font-semibold">{P.active}</span>
          <Toggle checked={active} onChange={setActive} label={P.active} />
        </div>
      )}
    </Modal>
  );
}

function ReceiveForm({
  products,
  initial,
  currency,
  today,
  onClose,
  onSave,
}: {
  products: StockProduct[];
  initial: string;
  currency: string;
  today: string;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const S = t.stock;
  const R = S.receiveForm;
  const [productId, setProductId] = useState(initial || products[0]?.id || "");
  const [packs, setPacks] = useState("1");
  const [packPrice, setPackPrice] = useState("");
  const [lot, setLot] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [receivedOn, setReceivedOn] = useState(today);
  const [method, setMethod] = useState("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const p = products.find((x) => x.id === productId);
  const nPacks = Number(packs);
  const price = Number(packPrice || 0);
  const valid = !!p && nPacks > 0 && price >= 0 && packPrice.trim() !== "";
  const qty = p ? nPacks * p.packSize : 0;
  const money = (n: number) => fmtMoney(n, currency, locale);
  const summary = p && valid
    ? (price > 0 ? R.summary : R.free)
        .replace("{qty}", productAmount(p.unit, qty, locale))
        .replace("{each}", money(price / p.packSize))
        .replace("{total}", money(nPacks * price))
    : "";

  const submit = async () => {
    setBusy(true);
    await onSave({ productId, packs: nPacks, packPrice: price, lot: lot.trim(), expiresOn: expiresOn || null, receivedOn: receivedOn || null, method, note: note.trim() });
    setBusy(false);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={R.title}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {S.cancel}
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!valid} data-receive-save>
            {S.save}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={R.product}>
          <Select value={productId} onChange={(e) => setProductId(e.target.value)} data-receive-product>
            {products.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.company ? ` · ${x.company}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={R.packs}>
            <Input type="text" inputMode="decimal" value={packs} onChange={(e) => setPacks(e.target.value)} dir="ltr" data-receive-packs />
          </Field>
          <Field label={`${R.packPrice} (${currency})`}>
            <Input type="text" inputMode="decimal" value={packPrice} onChange={(e) => setPackPrice(e.target.value)} dir="ltr" data-receive-price />
          </Field>
          <Field label={R.lot}>
            <Input value={lot} onChange={(e) => setLot(e.target.value)} placeholder={R.lotPlaceholder} maxLength={40} dir="ltr" data-receive-lot />
          </Field>
          <Field label={R.expiresOn}>
            <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} dir="ltr" data-receive-expires />
          </Field>
          <Field label={R.receivedOn}>
            <Input type="date" value={receivedOn} max={today} onChange={(e) => setReceivedOn(e.target.value)} dir="ltr" data-receive-on />
          </Field>
        </div>
        <Field label={R.method}>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {(["cash", "cliq", "card", "transfer", "cheque"] as const).map((m) => (
              <option key={m} value={m}>
                {R.methods[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={R.note}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-14" />
        </Field>
        {summary && <p className="rounded-ctl bg-sunken px-3 py-2 text-[13px] text-ink-700 tnum">{summary}</p>}
      </div>
    </Modal>
  );
}

function AdjustForm({
  product,
  batch,
  onClose,
  onSave,
}: {
  product: StockProduct;
  batch: StockBatch;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const S = t.stock;
  const A = S.adjustForm;
  const [onHand, setOnHand] = useState(String(batch.onHand));
  const [reason, setReason] = useState<"waste" | "expired" | "count">("waste");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = onHand.trim() !== "" && Number(onHand) >= 0;
  return (
    <Modal
      open
      onClose={onClose}
      title={`${A.title} — ${product.name}${batch.lot ? ` · ${batch.lot}` : ""}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {S.cancel}
          </Button>
          <Button
            onClick={async () => {
              setBusy(true);
              await onSave({ batchId: batch.id, onHand: Number(onHand), reason, note: note.trim() });
              setBusy(false);
            }}
            loading={busy}
            disabled={!valid}
            data-adjust-save
          >
            {S.save}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={`${A.onHand} (${S.product.units[product.unit]})`}>
          <Input type="text" inputMode="decimal" value={onHand} onChange={(e) => setOnHand(e.target.value)} dir="ltr" data-adjust-on-hand />
        </Field>
        <Field label={A.reason}>
          <Select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            {(["waste", "expired", "count"] as const).map((r) => (
              <option key={r} value={r}>
                {A.reasons[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={A.note}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={250} />
        </Field>
      </div>
    </Modal>
  );
}

function CompaniesForm({
  open,
  companies,
  onClose,
  onSave,
  onDelete,
  onRestore,
}: {
  open: boolean;
  companies: Company[];
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<boolean>;
  onDelete: (c: Company) => void;
  onRestore: (c: Company) => void;
}) {
  const { t } = useI18n();
  const S = t.stock;
  const C = S.companyForm;
  const [editing, setEditing] = useState<Company | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const clear = () => {
    setEditing(null);
    setName("");
    setPhone("");
    setNote("");
  };
  const edit = (c: Company) => {
    setEditing(c);
    setName(c.name);
    setPhone(c.phone);
    setNote(c.note);
  };
  const add = async () => {
    setBusy(true);
    const data = { name: name.trim(), phone: phone.trim(), note: note.trim() };
    if (await onSave(editing ? { ...data, id: editing.id } : data)) clear();
    setBusy(false);
  };
  return (
    <Modal open={open} onClose={onClose} title={C.title}>
      <div className="grid gap-3" data-companies>
        {companies.length === 0 && <p className="text-[13px] text-ink-500">{C.none}</p>}
        <ul className="divide-y divide-line">
          {companies.map((c) => (
            <li key={c.id} className={`flex items-center gap-3 py-2 ${c.active ? "" : "opacity-60"}`} data-company={c.id}>
              <span className="min-w-0 flex-1 text-[14px] font-medium" dir="auto">
                {c.name}
                {c.phone && <span className="ms-2 text-[12.5px] text-ink-500" dir="ltr">{c.phone}</span>}
                {c.note && <span className="block text-[12.5px] font-normal text-ink-500">{c.note}</span>}
              </span>
              <button type="button" onClick={() => edit(c)} className="text-[12.5px] font-semibold text-brand-700 hover:underline" data-company-edit>
                {C.edit}
              </button>
              {c.active ? (
                <button type="button" aria-label={S.delete} onClick={() => onDelete(c)} className="text-ink-400 hover:text-danger" data-company-delete>
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : (
                <button type="button" onClick={() => onRestore(c)} className="text-[12.5px] font-semibold text-brand-700 hover:underline" data-company-restore>
                  {C.restore}
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <div className="min-w-0 flex-[1_1_10rem]">
            <Field label={C.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} dir="auto" data-company-name />
            </Field>
          </div>
          <div className="min-w-0 flex-[1_1_8rem]">
            <Field label={C.phone}>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} dir="ltr" />
            </Field>
          </div>
          <div className="min-w-0 basis-full">
            <Field label={C.note}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} dir="auto" data-company-note />
            </Field>
          </div>
          <Button onClick={() => void add()} loading={busy} disabled={!name.trim()} data-company-add>
            {editing ? S.save : C.add}
          </Button>
          {editing && (
            <Button variant="outline" onClick={clear}>
              {C.cancelEdit}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
