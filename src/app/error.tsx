"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { CloudOff, RotateCw } from "lucide-react";

/**
 * What a clinic sees when a page throws.
 *
 * It replaces Next.js's default, which reads "Application error: a server-side
 * exception has occurred (see the server logs for more information)" followed by
 * a digest. Nobody at a front desk has server logs, and that wording gives them
 * no way to tell a passing blip from something worth a phone call — so the
 * honest failure mode of the whole product was a sentence addressed to a
 * developer.
 *
 * The overwhelmingly common cause is the database being briefly unreachable, so
 * the copy leads with "this usually clears on its own" and the button retries.
 *
 * This boundary sits inside the root layout, which is what makes `useI18n`
 * safe here: the layout only reads a cookie, so it renders even when nothing
 * else can, and its provider is already above us. `global-error.tsx` covers the
 * case where the layout itself is what failed, and cannot assume any of that.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    // The digest is all that ties this screen to a line in the server logs.
    console.error("[app error]", error.digest ?? "", error.message);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <CloudOff className="h-12 w-12 text-ink-400" strokeWidth={1.5} />
      <h1 className="text-xl font-semibold">{t.common.appErrorTitle}</h1>
      <p className="max-w-md text-sm leading-relaxed text-ink-500">{t.common.appErrorBody}</p>
      <Button onClick={reset}>
        <RotateCw className="h-4 w-4" />
        {t.common.appErrorRetry}
      </Button>
      {error.digest && (
        <p className="mono text-[12px] text-ink-400" dir="ltr">
          {t.common.appErrorRef}: {error.digest}
        </p>
      )}
    </main>
  );
}
