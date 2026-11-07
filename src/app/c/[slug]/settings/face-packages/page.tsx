import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadPlans } from "@/lib/charts/face/packages";
import { loadClinicTreatments } from "@/lib/charts/face/treatments";
import { FaceCatalogProvider } from "@/components/charts/face/catalog-context";
import { FacePackages } from "./face-packages";

/*
  Face packages: what the clinic sells by the package — six laser sessions,
  a toxin with a filler — and for how much. Sold from the patient's face chart.
*/
export default async function FacePackagesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.services");
  if (!access.clinic.features.aesthetic) redirect(`/c/${slug}/settings/services`);
  const { plans, custom } = await inClinic(access, async (c) => ({
    plans: await loadPlans(c, access.clinicId, false),
    custom: (await loadClinicTreatments(c, access.clinicId)).custom,
  }));
  return (
    <FaceCatalogProvider custom={custom}>
      <FacePackages slug={slug} currency={access.clinic.currency} plans={plans} />
    </FaceCatalogProvider>
  );
}
