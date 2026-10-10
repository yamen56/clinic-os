import { redirect } from "next/navigation";

/*
  The Imaging page became Devices, for every kind of clinic. Kept as a
  redirect: imaging computers already have this address open, and the
  folder they were watching is remembered per clinic, not per address.
*/
export default async function ImagingMoved({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/c/${slug}/devices`);
}
