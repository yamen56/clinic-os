"use client";

/*
  The medical history card for a dental clinic: the shared card
  (components/medical-card.tsx), bound to the chart's store so an edit shows
  in the chart and the file's header at once, and saved through the chart's
  writer like every other change made there.

  It lived in the Treatment tab's case header until that tab was taken out
  (2026-10-12); the data is the same `patients.medical_history`.
*/

import { MedicalCard } from "@/components/medical-card";
import { useOptionalDentalStore } from "./store";
import { useChartWriter } from "./writer";

/** Only inside the dental chart's provider — the caller checks for the store. */
export function DentalMedicalCard({ tz }: { tz: string }) {
  const store = useOptionalDentalStore()!;
  const w = useChartWriter();
  return <MedicalCard tz={tz} value={store.medical} onSave={w.saveMedical} />;
}
