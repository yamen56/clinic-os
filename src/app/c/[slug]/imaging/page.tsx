import { guardCap } from "@/lib/guard";
import { ImagingStation } from "./station-client";

/*
  The imaging station: this page, left open in Chrome or Edge on the computer
  beside the x-ray machine. It watches the folder the x-ray software saves to
  and sends each new image to the patient a doctor is waiting on. Uploading is
  what opening a patient's file already allows, so that is the gate.
*/
export default async function ImagingStationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await guardCap(slug, "patients");
  return <ImagingStation slug={slug} />;
}
