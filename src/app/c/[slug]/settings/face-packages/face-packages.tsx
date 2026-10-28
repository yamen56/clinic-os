"use client";

/*
  Face packages: each is a card — what it holds, its price, how long it is
  good for. New package and Edit open one form: the names in both languages,
  the price, the months, and the treatments with their sessions. A package
  no longer sold is set aside, not deleted: the patients who bought it keep it.
*/

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { fmtMoney } from "@/lib/dates";
import { FACE_TREATMENTS, FACE_TREATMENT_BY_KEY } from "@/lib/charts/face/catalog";
import type { PackagePlan, PlanItem } from "@/lib/charts/face/packages";
import { FamilyTag } from "@/components/charts/face/family-tag";
import { savePlanAction } from "./actions";

export function FacePackages({ slug, currency, plans: initial }: { slug: string; currency: string; plans: PackagePlan[] }) {
  const { t, locale } = useI18n();
  const P = t.services.facePackages;
  const { toast } = useToast();
  const [plans, setPlans] = useState(initial);
  const [editing, setEditing] = useState<PackagePlan | "new" | null>(null);

  const save = async (data: Record<string, unknown>) => {
    const r = await savePlanAction(slug, data);
    if (r.error || !r.plans) {
      toast(P.failed, "error");
      return false;
    }
    setPlans(r.plans);
    toast(P.saved);
    return true;
  };

  return (
    <div className="grid gap-4" data-face-packages>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold">{P.title}</h2>
          <p className="mt-1 max-w-3xl text-[13px] text-ink-500">{P.sub}</p>
        </div>
        <Button onClick={() => setEditing("new")} data-plan-new>
          <Plus className="h-4 w-4" />
          {P.add}
        </Button>
      </div>
      {plans.length === 0 ? (
        <Card className="p-6 text-[14px] text-ink-500">{P.empty}</Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {plans.map((p) => (
            <Card key={p.id} className={`p-4 ${p.active ? "" : "opacity-60"}`}>
              <div data-plan={p.id}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold" dir="auto">
                      {locale === "ar" ? p.nameAr || p.name : p.name}
                    </div>
                    {p.nameAr && locale !== "ar" && (
                      <div className="text-[12.5px] text-ink-500" dir="rtl">
                        {p.nameAr}
                      </div>
                    )}
                  </div>
                  <div className="text-[17px] font-bold tnum">{fmtMoney(p.price, currency, locale)}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5" dir="ltr">
                  {p.items.map((i, n) => {
                    const tr = FACE_TREATMENT_BY_KEY.get(i.treatmentKey);
                    return tr ? <FamilyTag key={n} family={tr.family} label={`${tr.en} × ${i.sessions}`} /> : null;
                  })}
                </div>
                <div className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-500">
                  <span>{p.validMonths ? P.validFor.replace("{n}", String(p.validMonths)) : P.noExpiry}</span>
                  {!p.active && <span>· {P.inactive}</span>}
                  <Button size="sm" variant="outline" className="ms-auto" onClick={() => setEditing(p)}>
                    {P.edit}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && <PlanForm plan={editing === "new" ? null : editing} currency={currency} onClose={() => setEditing(null)} onSave={async (d) => (await save(d)) && setEditing(null)} />}
    </div>
  );
}

function PlanForm({ plan, currency, onClose, onSave }: { plan: PackagePlan | null; currency: string; onClose: () => void; onSave: (d: Record<string, unknown>) => Promise<unknown> }) {
  const { t } = useI18n();
  const P = t.services.facePackages;
  const [name, setName] = useState(plan?.name ?? "");
  const [nameAr, setNameAr] = useState(plan?.nameAr ?? "");
  const [price, setPrice] = useState(plan ? String(plan.price) : "");
  const [months, setMonths] = useState(plan?.validMonths ? String(plan.validMonths) : "");
  const [items, setItems] = useState<PlanItem[]>(plan?.items.length ? plan.items : [{ treatmentKey: "aes_laser_hair", sessions: 6 }]);
  const [active, setActive] = useState(plan?.active ?? true);
  const [busy, setBusy] = useState(false);
  const valid = name.trim() && price.trim() !== "" && Number(price) >= 0 && items.length > 0 && items.every((i) => i.sessions >= 1);
  const setItem = (n: number, patch: Partial<PlanItem>) => setItems((prev) => prev.map((x, i) => (i === n ? { ...x, ...patch } : x)));

  return (
    <Modal
      open
      onClose={onClose}
      title={plan ? P.editTitle : P.newTitle}
      wide
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {P.cancel}
          </Button>
          <Button
            onClick={async () => {
              setBusy(true);
              await onSave({
                id: plan?.id ?? null,
                name: name.trim(),
                nameAr: nameAr.trim(),
                price: Number(price),
                validMonths: months.trim() ? Number(months) : null,
                active,
                items,
              });
              setBusy(false);
            }}
            loading={busy}
            disabled={!valid}
            data-plan-save
          >
            {P.save}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={P.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={P.namePlaceholder} dir="auto" data-plan-name />
        </Field>
        <Field label={P.nameAr}>
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={80} dir="rtl" />
        </Field>
        <Field label={`${P.price} (${currency})`}>
          <Input type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} dir="ltr" data-plan-price />
        </Field>
        <Field label={P.months} hint={P.monthsHint}>
          <Input type="text" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, "").slice(0, 2))} dir="ltr" />
        </Field>
      </div>
      <div className="mt-4">
        <div className="text-[13px] font-semibold text-ink-900">{P.items}</div>
        <div className="text-xs text-ink-500">{P.itemsHint}</div>
        <div className="mt-2 grid gap-2" dir="ltr">
          {items.map((it, n) => (
            <div key={n} className="flex items-center gap-2" data-plan-item={n}>
              <Select value={it.treatmentKey} onChange={(e) => setItem(n, { treatmentKey: e.target.value })} className="min-w-0 flex-1">
                {FACE_TREATMENTS.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.en}
                  </option>
                ))}
              </Select>
              <span className="text-[13px] text-ink-500">×</span>
              <div className="w-20 shrink-0">
                <Input
                  type="text"
                  inputMode="numeric"
                  value={String(it.sessions)}
                  onChange={(e) => setItem(n, { sessions: Math.min(100, Number(e.target.value.replace(/\D/g, "")) || 0) })}
                  aria-label={P.sessions}
                  className="text-center"
                />
              </div>
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((_, i) => i !== n))}
                disabled={items.length === 1}
                aria-label={P.removeItem}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-ctl text-ink-500 hover:bg-sunken disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        {items.length < 10 && (
          <button
            type="button"
            onClick={() => setItems((prev) => [...prev, { treatmentKey: "aes_toxin", sessions: 1 }])}
            className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-700 hover:underline"
            data-plan-add-item
          >
            <Plus className="h-3.5 w-3.5" />
            {P.addItem}
          </button>
        )}
      </div>
      {plan && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="text-[13px] font-semibold">{P.active}</span>
          <Toggle checked={active} onChange={setActive} label={P.active} />
        </div>
      )}
    </Modal>
  );
}
