"use client";

import { useState, useTransition } from "react";
import { impersonateAction, setClinicSpecialtyAction } from "../../actions";
import { SPECIALTIES, type Specialty } from "@/lib/specialties";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DepartmentPicker } from "../../department-picker";
import { SpecialtyAdds } from "../../specialty-adds";
import type { AdminCapabilityMap } from "@/lib/admin-permissions";
import { SUPPORT_REASON_MAX, SUPPORT_REASON_MIN } from "@/lib/support-visits";
import { ExternalLink, Stethoscope } from "lucide-react";

/**
 * The two things the agency does to a clinic from its header: change what it
 * practises, and go inside on a support visit. The plan, its price and its
 * modules moved to the Plan & billing tab (2026-11-27).
 */
export function ClinicAdminPanel({
  clinic,
  caps,
  visitHours,
}: {
  clinic: {
    id: string;
    slug: string;
    name: string;
    specialty: Specialty;
    /** A medical centre's other departments. */
    departments: Specialty[];
    deleted: boolean;
  };
  caps: AdminCapabilityMap;
  /** How long a visit lasts, from the server — the env override lives there. */
  visitHours: number;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [specialtyOpen, setSpecialtyOpen] = useState(false);
  const [specialty, setSpecialty] = useState<Specialty>(clinic.specialty);
  const [departments, setDepartments] = useState<Specialty[]>(clinic.departments);
  const [specPending, startSpec] = useTransition();
  const [impPending, startImp] = useTransition();
  const [enterOpen, setEnterOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);

  /*
    A deleted clinic has one meaningful action left — restore — and it lives in
    the danger zone. Everything here would fail on the server (impersonation
    refuses a deleted clinic outright) or edit a workspace nobody can open.
  */
  if (clinic.deleted) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {caps["clinics.edit"] && (
        <Button variant="outline" onClick={() => setSpecialtyOpen(true)}>
          <Stethoscope className="h-4 w-4" />
          {t.admin.specialty}
        </Button>
      )}
      {caps["clinics.impersonate"] && (
        <Button onClick={() => setEnterOpen(true)}>
          <ExternalLink className="h-4 w-4" />
          {t.admin.openWorkspace}
        </Button>
      )}

      {/*
        A reason before the door opens. It is saved with the visit and shown to
        the clinic's owner, which is what makes the record answer "why was the
        agency in my clinic" rather than only "when".
      */}
      <Modal open={enterOpen} onClose={() => setEnterOpen(false)} title={t.admin.enterTitle.replace("{clinic}", clinic.name)}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length < SUPPORT_REASON_MIN) {
              setReasonError(true);
              return;
            }
            startImp(async () => {
              const r = await impersonateAction(clinic.slug, reason);
              if (r?.error === "reason") setReasonError(true);
              else if (r?.error) toast(t.common.genericError, "error");
            });
          }}
        >
          <p className="text-[0.8125rem] text-ink-500">{t.admin.enterNotice.replace("{h}", String(visitHours))}</p>
          <Field label={t.admin.enterReason} error={reasonError ? t.admin.enterReasonError : undefined}>
            <Input
              name="reason"
              autoFocus
              maxLength={SUPPORT_REASON_MAX}
              placeholder={t.admin.enterReasonPlaceholder}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError) setReasonError(false);
              }}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEnterOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={impPending}>
              <ExternalLink className="h-4 w-4" />
              {t.admin.enterConfirm}
            </Button>
          </div>
        </form>
      </Modal>

      {/*
        What it practises decides its charts, the machines it usually connects
        and the result kinds it files (lib/specialty-profile). It no longer
        brings automation packs (2026-11-27).
      */}
      <Modal open={specialtyOpen} onClose={() => setSpecialtyOpen(false)} title={t.admin.specialty}>
        <div className="grid gap-4">
          <p className="text-[0.8125rem] text-ink-500">{t.admin.specialtySub}</p>
          <Field label={t.admin.specialty} hint={t.admin.specialtyHint}>
            <Select value={specialty} onChange={(e) => setSpecialty(e.target.value as Specialty)}>
              {SPECIALTIES.map((s) => (
                <option key={s} value={s}>
                  {t.specialties[s]}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <div className="mb-1 text-[0.8125rem] font-semibold text-ink-900">{t.admin.departments}</div>
            <p className="mb-2 text-[0.75rem] text-ink-500">{t.admin.departmentsSub}</p>
            <DepartmentPicker value={departments} onChange={setDepartments} primary={specialty} disabled={specPending} />
          </div>
          <SpecialtyAdds specialties={[specialty, ...departments.filter((d) => d !== specialty)]} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setSpecialty(clinic.specialty);
                setDepartments(clinic.departments);
                setSpecialtyOpen(false);
              }}
            >
              {t.common.cancel}
            </Button>
            <Button
              loading={specPending}
              data-save-specialty
              onClick={() =>
                startSpec(async () => {
                  const r = await setClinicSpecialtyAction(clinic.slug, specialty, departments.filter((d) => d !== specialty));
                  toast(r.error ? t.common.genericError : t.common.saved, r.error ? "error" : "success");
                  setSpecialtyOpen(false);
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
