"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  impersonateAction,
  updateSubscriptionAction,
  updateClinicFeaturesAction,
} from "../../actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { FeaturePicker } from "../../feature-picker";
import { toFeatureSetting, type FeatureMap } from "@/lib/features";
import type { AdminCapabilityMap } from "@/lib/admin-permissions";
import { ExternalLink, Settings2, SlidersHorizontal } from "lucide-react";

export function ClinicAdminPanel({
  clinic,
  caps,
}: {
  clinic: {
    id: string;
    slug: string;
    subscriptionStatus: string;
    plan: string;
    planPrice: number;
    features: FeatureMap;
    deleted: boolean;
  };
  caps: AdminCapabilityMap;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(false);
  const [status, setStatus] = useState(clinic.subscriptionStatus);
  const [plan, setPlan] = useState(clinic.plan);
  const [price, setPrice] = useState(String(clinic.planPrice));
  const [features, setFeatures] = useState(clinic.features);
  const [pending, start] = useTransition();
  const [featPending, startFeat] = useTransition();
  const [impPending, startImp] = useTransition();

  /*
    A deleted clinic has one meaningful action left — restore — and it lives in
    the danger zone below. Everything here would either fail on the server
    (impersonation refuses a deleted clinic outright) or quietly edit a licence
    for a workspace nobody can open.
  */
  if (clinic.deleted) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {caps["clinics.features"] && (
        <Button variant="outline" onClick={() => setFeaturesOpen(true)}>
          <SlidersHorizontal className="h-4 w-4" />
          {t.admin.features}
        </Button>
      )}
      {caps["clinics.edit"] && (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Settings2 className="h-4 w-4" />
          {t.admin.subscription}
        </Button>
      )}
      {caps["clinics.impersonate"] && (
        <Button
          loading={impPending}
          onClick={() => startImp(async () => impersonateAction(clinic.slug))}
        >
          <ExternalLink className="h-4 w-4" />
          {t.admin.openWorkspace}
        </Button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t.admin.subscription}>
        <div className="grid gap-4">
          <Field label={t.common.status}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="trial">{t.admin.trial}</option>
              <option value="active">{t.admin.activeSub}</option>
              <option value="past_due">{t.admin.pastDue}</option>
              <option value="suspended">{t.admin.suspended}</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t.admin.plan}>
              <Input value={plan} onChange={(e) => setPlan(e.target.value)} />
            </Field>
            <Field label={t.admin.planPrice}>
              <Input
                dir="ltr"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              loading={pending}
              onClick={() =>
                start(async () => {
                  await updateSubscriptionAction(clinic.id, {
                    status,
                    plan,
                    planPrice: Number(price) || 0,
                  });
                  toast(t.common.saved);
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {t.common.save}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={featuresOpen} onClose={() => setFeaturesOpen(false)} title={t.admin.features}>
        <div className="grid gap-4">
          <p className="text-[13px] text-ink-500">{t.admin.featuresSub}</p>
          <FeaturePicker value={features} onChange={setFeatures} disabled={featPending} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                // Discard, don't keep. Reopening the dialog after a cancel and
                // finding yesterday's half-made edit still ticked is how the
                // wrong licence gets saved by accident.
                setFeatures(clinic.features);
                setFeaturesOpen(false);
              }}
            >
              {t.common.cancel}
            </Button>
            <Button
              loading={featPending}
              onClick={() =>
                startFeat(async () => {
                  await updateClinicFeaturesAction(clinic.id, toFeatureSetting(features));
                  toast(t.admin.featuresSaved);
                  setFeaturesOpen(false);
                  router.refresh();
                })
              }
            >
              {t.common.save}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
