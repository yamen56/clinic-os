"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import type { ChartImage } from "@/components/charts/dental/image-viewer";

/**
 * The picture, the patient's WhatsApp, and a line of text — above the x-ray
 * viewer, which is why it is its own layer rather than the app's Modal (that
 * one sits beneath the viewer). The caption starts in the clinic's language
 * and can be changed or emptied before it goes.
 */
export function SendToPatient({
  img,
  initialCaption,
  onClose,
  onSend,
}: {
  img: ChartImage;
  initialCaption: string;
  onClose: () => void;
  onSend: (caption: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const T = t.viewer;
  const [text, setText] = useState(initialCaption);
  const [busy, setBusy] = useState(false);
  // Escape closes this, not the viewer beneath it: caught on window, before the viewer (on document) hears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={T.sendToPatient} data-send-dialog>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative m-0 w-full max-w-md rounded-t-modal bg-surface p-5 text-ink-900 shadow-modal sm:m-4 sm:rounded-modal" dir="ltr">
        <div className="mb-3 flex items-start gap-3">
          {
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img.src} alt="" className="h-16 w-24 shrink-0 rounded-md bg-black object-cover" />
          }
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold">{T.sendToPatient}</h2>
            <p className="truncate text-[13px] text-ink-500">{img.name}</p>
          </div>
        </div>
        <label className="block text-[13px] font-semibold">
          {T.sendCaption}
          <textarea
            dir="auto"
            value={text}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="mt-1.5 block w-full rounded-ctl border border-line bg-surface px-3 py-2 text-base font-normal md:text-sm"
            data-send-caption
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {T.cancel}
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSend(text);
              } finally {
                setBusy(false);
              }
            }}
            data-send-confirm
          >
            {T.send}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Queue the picture to the patient's WhatsApp; the outcome, for a toast. */
export async function sendPictureToPatient(
  slug: string,
  fileId: string,
  caption: string
): Promise<"ok" | "no_phone" | "whatsapp_not_connected" | "failed"> {
  const res = await fetch(`/api/c/${slug}/files/${fileId}/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caption }),
  });
  if (res.ok) return "ok";
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error === "no_phone" || body.error === "whatsapp_not_connected" ? body.error : "failed";
}
