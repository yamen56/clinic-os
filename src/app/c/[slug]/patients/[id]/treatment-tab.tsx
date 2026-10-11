"use client";

/*
  The Treatment tab: where the doctor works the patient's treatment.

  The same chart as the Dental chart tab — the same entries, drawn the same
  way, held once for the whole file — around a case: what brought the patient
  in, the history, the examination and the diagnosis above it; the plan
  beside it, with what comes next and when; and below it, what was done at
  each visit. The Dental chart tab stays the overview of the whole mouth; this
  one is for doing.

  English inside, like the chart, whatever the workspace speaks.
*/

import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { fmtDateOnly } from "@/lib/dates";
import { CaseHeader } from "@/components/charts/dental/case-header";
import { VisitsList } from "@/components/charts/dental/visits";
import { DentalChart, type DentalTabData } from "./dental-chart-tab";

export function TreatmentTab({
  slug,
  patientId,
  tz,
  birthDate,
  data,
  onPrescribe,
}: {
  slug: string;
  patientId: string;
  tz: string;
  birthDate: string | null;
  data: DentalTabData;
  /** Start a prescription with the case's diagnosis; absent for a member who may not write one. */
  onPrescribe?: (diagnosis: string) => void;
}) {
  const { t, locale } = useI18n();
  // Words for the patient are in the clinic's language, not the chart's English.
  const caption = (dateIso: string) => t.devices.xrayCaption.replace("{clinic}", data.clinicName).replace("{date}", fmtDateOnly(dateIso, locale));
  return (
    <I18nProvider dict={t} locale="en">
      <div dir="ltr" lang="en" className="grid gap-4 font-sans" data-latin-island data-treatment-tab>
        <CaseHeader tz={tz} onPrescribe={onPrescribe} />
        <DentalChart slug={slug} patientId={patientId} tz={tz} birthDate={birthDate} data={data} caption={caption} mode="treatment" />
        <VisitsList tz={tz} />
      </div>
    </I18nProvider>
  );
}
