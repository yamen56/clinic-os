"use client";

/*
  A face treatment the clinic does that the chart does not list (0094): made at
  the chair, on the areas the doctor picked, or in Settings → Face prices, where
  it then waits for its price (Yamen, 2026-11-08: "in the settings, the prices, I
  want to be able to add the new treatments there too").
*/

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Select } from "@/components/ui/input";
import { BACK_ZONES, FACE_ZONES, FAMILIES, whereText, type Family, type FaceTreatment, type FaceVariant, type PricedBy, type TreatmentLook } from "@/lib/charts/face/catalog";

export type TreatmentsAnswer = { ok?: boolean; key?: string; variantId?: string; custom: FaceTreatment[]; variants: FaceVariant[]; looks?: TreatmentLook[]; error?: string };

export async function treatmentsCall(slug: string, body: Record<string, unknown>): Promise<TreatmentsAnswer> {
  const res = await fetch(`/api/c/${slug}/face/treatments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return ((await res.json().catch(() => ({ error: "failed" }))) as TreatmentsAnswer) ?? { error: "failed" };
}

/**
 * A treatment the clinic does that the chart does not list, made at the chair.
 * It starts on the areas the doctor picked, which is where it was just done.
 */
export function AddTreatment({
  slug,
  zones,
  onClose,
  onAdded,
}: {
  slug: string;
  zones: string[];
  onClose: () => void;
  onAdded: (key: string, custom: FaceTreatment[], variants: FaceVariant[], looks?: TreatmentLook[]) => void;
}) {
  const { t } = useI18n();
  const F = t.face;
  const N = F.newTreatment;
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [family, setFamily] = useState<Family>("skin");
  const [pricedBy, setPricedBy] = useState<PricedBy>("session");
  const [units, setUnits] = useState(false);
  const [anywhere, setAnywhere] = useState(zones.length === 0);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    const r = await treatmentsCall(slug, {
      op: "create",
      name: name.trim(),
      nameAr: nameAr.trim() || null,
      family,
      pricedBy,
      units: units || pricedBy === "unit",
      fits: anywhere || !zones.length ? [...FACE_ZONES, ...BACK_ZONES].map((z) => z.key) : zones,
    });
    setBusy(false);
    if (!r.key) return toast(r.error === "exists" ? N.exists : t.common.genericError, "error");
    onAdded(r.key, r.custom, r.variants, r.looks);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={N.title}
      footer={
        <Button onClick={() => void create()} loading={busy} disabled={!name.trim()} data-face-new-save>
          {N.create}
        </Button>
      }
    >
      <div className="grid gap-3">
        <label className="grid gap-1 text-[13px] font-semibold">
          {N.name}
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-face-new-name />
        </label>
        <label className="grid gap-1 text-[13px] font-semibold">
          {N.nameAr}
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} maxLength={80} dir="rtl" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-[13px] font-semibold">
            {N.family}
            <Select value={family} onChange={(e) => setFamily(e.target.value as Family)} data-face-new-family>
              {FAMILIES.map((f) => (
                <option key={f} value={f}>
                  {F.families[f]}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-[13px] font-semibold">
            {N.pricedBy}
            <Select value={pricedBy} onChange={(e) => setPricedBy(e.target.value as PricedBy)} data-face-new-priced>
              {(["session", "area", "unit", "syringe", "thread"] as const).map((p) => (
                <option key={p} value={p}>
                  {F.pricedBy[p]}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <label className="flex min-h-10 items-center gap-2 text-[13.5px]">
          <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={units || pricedBy === "unit"} disabled={pricedBy === "unit"} onChange={(e) => setUnits(e.target.checked)} />
          {N.units}
        </label>
        <div className="grid gap-1">
          <div className="text-[13px] font-semibold">{N.where}</div>
          {zones.length > 0 && (
            <label className="flex min-h-10 items-center gap-2 text-[13.5px]">
              <input type="radio" name="where" className="h-4 w-4 accent-brand-600" checked={!anywhere} onChange={() => setAnywhere(false)} />
              {N.whereSelected}: {whereText(zones, "en")}
            </label>
          )}
          <label className="flex min-h-10 items-center gap-2 text-[13.5px]">
            <input type="radio" name="where" className="h-4 w-4 accent-brand-600" checked={anywhere} onChange={() => setAnywhere(true)} data-face-new-anywhere />
            {N.whereAll}
          </label>
        </div>
      </div>
    </Modal>
  );
}
