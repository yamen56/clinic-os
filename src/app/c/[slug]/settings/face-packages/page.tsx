import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { loadPlans } from "@/lib/charts/face/packages";
import { FacePackages } from "./face-packages";

/*
  Face packages: what the clinic sells by the package — six laser sessions,
  a toxin with a filler — and for how much. Sold from the patient's face chart.
*/
export default async function FacePackagesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings.services");
  if (!access.clinic.features.aesthetic) redirect(`/c/${slug}/settings/services`);
  const plans = await inClinic(access, (c) => loadPlans(c, access.clinicId, false));
  return <FacePackages slug={slug} currency={access.clinic.currency} plans={plans} />;
}
