"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { DOC_STATUS_BADGE } from "@/components/esign/status";
import { FileSignature, Send, Tablet, Check } from "lucide-react";

type Row = {
  templateId: string;
  templateName: string;
  templateNameAr: string | null;
  autoSend: boolean;
  documentId: string | null;
  status: string | null;
};

/**
 * "Required documents" inside the appointment panel.
 *
 * The booked service decides what appears here. Reception should be able to see
 * that a consent form is outstanding at the moment they are looking at the
 * appointment, and fix it in one click — chasing it from a separate screen is
 * how forms end up unsigned on the day.
 */
export function RequiredDocuments({
  slug,
  appointmentId,
  canSend,
}: {
  slug: string;
  appointmentId: string;
  canSend: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/c/${slug}/appointments/${appointmentId}/documents`);
    if (!res.ok) {
      setRows([]);
      return;
    }
    const data = (await res.json()) as { documents: Row[] };
    setRows(data.documents ?? []);
  }, [slug, appointmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const raise = async (templateId: string, send: boolean) => {
    setBusy(templateId);
    try {
      const res = await fetch(`/api/c/${slug}/appointments/${appointmentId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, send }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        documentId?: string;
        error?: string;
        delivered?: number;
      };
      if (!res.ok || !data.documentId) {
        toast(t.common.genericError, "error");
        return;
      }
      if (data.error) {
        // Usually a missing merge value — the document exists, so send them to it
        // rather than making them guess what went wrong.
        toast(
          (t.docs.errors as Record<string, string>)[data.error] ?? t.common.genericError,
          "error"
        );
        router.push(`/c/${slug}/documents/${data.documentId}`);
        return;
      }
      if (send) {
        toast(data.delivered ? t.docs.sentOk : t.docs.sentToStaffOk);
        await load();
      } else {
        router.push(`/c/${slug}/documents/${data.documentId}`);
      }
    } finally {
      setBusy(null);
    }
  };

  // Nothing to say when the service needs no paperwork.
  if (rows === null || rows.length === 0) return null;

  const allSigned = rows.every((r) => r.status === "completed");

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <FileSignature className="h-4 w-4 text-ink-400" />
        <span className="text-[13px] font-semibold">{t.docs.requiredDocuments}</span>
        {allSigned && (
          <Badge status="confirmed">
            <Check className="h-3 w-3" />
            {t.docs.allSigned}
          </Badge>
        )}
      </div>
      <div className="grid gap-1.5">
        {rows.map((r) => {
          const name = locale === "ar" ? r.templateNameAr || r.templateName : r.templateName;
          return (
            <div
              key={r.templateId}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
              {r.documentId ? (
                <>
                  <Badge status={(DOC_STATUS_BADGE[r.status ?? ""] ?? "neutral") as StatusKey}>
                    {(t.docs.statuses as Record<string, string>)[r.status ?? ""] ?? r.status}
                  </Badge>
                  <Link href={`/c/${slug}/documents/${r.documentId}`}>
                    <Button variant="ghost" size="sm">
                      {t.common.open}
                    </Button>
                  </Link>
                </>
              ) : (
                <>
                  <Badge status="neutral">{t.docs.notSentYet}</Badge>
                  {canSend && (
                    <>
                      <Button
                        variant="soft"
                        size="sm"
                        loading={busy === r.templateId}
                        onClick={() => void raise(r.templateId, true)}
                      >
                        <Send className="h-4 w-4" />
                        {t.docs.sendForSignature}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busy === r.templateId}
                        onClick={() => void raise(r.templateId, false)}
                      >
                        <Tablet className="h-4 w-4" />
                        {t.docs.startSigning}
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
