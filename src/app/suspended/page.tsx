import { getDict } from "@/lib/i18n";
import { logoutAction } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { PauseCircle, Archive } from "lucide-react";

export default async function SuspendedPage({
  searchParams,
}: {
  searchParams: Promise<{ removed?: string }>;
}) {
  const t = await getDict();
  // Two dead ends, one page. A paused subscription is a conversation about
  // money and comes back the moment it is settled; a removed workspace is a
  // decision somebody made, and telling those two apart is the difference
  // between ringing the agency and ringing them urgently.
  const removed = (await searchParams).removed === "1";

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      {removed ? (
        <Archive className="h-12 w-12 text-ink-400" />
      ) : (
        <PauseCircle className="h-12 w-12 text-st-pending" />
      )}
      <h1 className="text-xl font-semibold">
        {removed ? t.auth.removedTitle : t.auth.suspendedTitle}
      </h1>
      <p className="max-w-md text-sm text-ink-500">
        {removed ? t.auth.removedBody : t.auth.suspendedBody}
      </p>
      <form action={logoutAction}>
        <Button variant="outline">{t.auth.signOut}</Button>
      </form>
    </main>
  );
}
