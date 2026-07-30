"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { DocumentBody } from "@/components/esign/document-body";
import { FileUp, AlertTriangle } from "lucide-react";

type Imported = {
  format: "docx" | "pdf";
  html: string;
  warnings: string[];
  characters: number;
};

/**
 * Brings a Word or PDF file the clinic already uses into the template body.
 *
 * The result is shown before it is accepted, because the two formats convert
 * very differently — Word keeps its structure, a PDF gives up its text and
 * nothing else — and the only person who can judge whether the result is usable
 * is the one who knows what the original said. Nothing is written until they
 * press insert.
 */
export function ImportFileButton({
  slug,
  dir,
  autoOpen,
  onInsert,
}: {
  slug: string;
  dir: "rtl" | "ltr";
  /** Open the file picker on mount — the visitor came here to import. */
  autoOpen?: boolean;
  /** Called with the body to use. Replaces whatever is in the editor. */
  onInsert: (html: string) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Imported | null>(null);

  useEffect(() => {
    /*
      Safari and Firefox only honour `.click()` on a file input inside a real
      user gesture; a mount is not one, so the picker may simply not open. That
      is why this is a shortcut and not the only route in — the button is right
      there either way.
    */
    if (autoOpen) inputRef.current?.click();
  }, [autoOpen]);

  const pick = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/c/${slug}/documents/import`, { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        toast(
          (t.docImport.errors as Record<string, string>)[json.error] ?? t.common.genericError,
          "error"
        );
        return;
      }
      setResult(json as Imported);
    } catch {
      toast(t.common.genericError, "error");
    } finally {
      setBusy(false);
      // Same file twice in a row should still fire a change event.
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void pick(f);
        }}
      />
      <Button
        variant="outline"
        size="sm"
        loading={busy}
        onClick={() => inputRef.current?.click()}
      >
        <FileUp className="h-4 w-4" />
        {t.docImport.cta}
      </Button>

      <Modal open={!!result} onClose={() => setResult(null)} title={t.docImport.reviewTitle} wide>
        {result && (
          <div className="grid gap-4">
            <p className="text-[13px] text-ink-500">{t.docImport.reviewBody}</p>

            {result.warnings.map((w) => (
              <div
                key={w}
                className="flex items-start gap-2.5 rounded-card border border-st-pending/30 bg-st-pending-soft px-4 py-3 text-st-pending"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-[12px] leading-relaxed">
                  {(t.docImport.warnings as Record<string, string>)[w] ?? w}
                </p>
              </div>
            ))}

            <div
              dir={dir}
              className="max-h-80 overflow-y-auto rounded-card border border-line bg-subtle p-4"
            >
              {result.characters === 0 ? (
                <p className="text-[13px] text-ink-500">{t.docImport.nothingFound}</p>
              ) : (
                <DocumentBody html={result.html} className="text-[13px] leading-relaxed" />
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setResult(null)}>
                {t.common.cancel}
              </Button>
              <Button
                disabled={result.characters === 0}
                onClick={() => {
                  onInsert(result.html);
                  setResult(null);
                  toast(t.docImport.inserted);
                }}
              >
                {t.docImport.insert}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
