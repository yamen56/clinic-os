import { getDict } from "@/lib/i18n";
import { logoutAction } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { PauseCircle } from "lucide-react";

export default async function SuspendedPage() {
  const t = await getDict();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <PauseCircle className="h-12 w-12 text-st-pending" />
      <h1 className="text-xl font-semibold">{t.auth.suspendedTitle}</h1>
      <p className="max-w-md text-sm text-ink-500">{t.auth.suspendedBody}</p>
      <form action={logoutAction}>
        <Button variant="outline">{t.auth.signOut}</Button>
      </form>
    </main>
  );
}
