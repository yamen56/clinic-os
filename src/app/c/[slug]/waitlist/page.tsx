import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";

/**
 * The waitlist is a tab of Appointments now, beside the calendar it fills.
 * This address stays for the links that already point at it — old
 * notifications, bookmarks, the notes feed of earlier versions.
 */
export default async function WaitlistPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await guardCap(slug, "calendar");
  redirect(`/c/${slug}/calendar?tab=waitlist`);
}
