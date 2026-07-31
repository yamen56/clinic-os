"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Download } from "lucide-react";

/**
 * Downloads the finished document — the signed page plus every signature and the
 * certificate of completion.
 *
 * A plain link was wrong here for two reasons. The file is often not built yet:
 * the worker renders it when the last signature lands, so a document that
 * completed seconds ago, or while the worker was down, has nothing stored. The
 * API builds it on demand in that case, which takes a few seconds of headless
 * Chromium — long enough that a bare link looks broken, and if it fails the
 * browser shows the raw error JSON in a new tab.
 *
 * So this fetches it, says it is working, and reports a failure as a message
 * rather than as a page full of JSON.
 */
export function DownloadSignedPdf({
  slug,
  documentId,
  title,
  variant = "outline",
  size,
  iconOnly,
}: {
  slug: string;
  documentId: string;
  title?: string;
  variant?: "outline" | "ghost" | "soft";
  size?: "sm" | "icon";
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/c/${slug}/documents/${documentId}/pdf`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(
          (t.docs.errors as Record<string, string>)[body.error] ?? t.common.genericError,
          "error"
        );
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // The server sends the real filename too, but a blob URL does not carry it.
      a.download = `${(title || "document").replace(/[^\w؀-ۿ .-]+/g, "_").slice(0, 60)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick: Safari has not finished reading it synchronously.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast(t.common.genericError, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      loading={busy}
      onClick={go}
      aria-label={iconOnly ? t.docs.downloadSigned : undefined}
      title={iconOnly ? t.docs.downloadSigned : undefined}
    >
      {!busy && <Download className="h-4 w-4" />}
      {!iconOnly && t.docs.downloadSigned}
    </Button>
  );
}
