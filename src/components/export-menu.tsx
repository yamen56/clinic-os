"use client";

import { useState } from "react";
import { ChevronDown, Download, FileSpreadsheet, FileText, FileType2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { useToast } from "@/components/ui/toast";
import { buttonClass } from "@/components/ui/button-class";
import { Menu, MenuItem } from "@/components/ui/menu";
import { ReauthPrompt } from "@/components/reauth-prompt";

export type ExportFormat = "xlsx" | "csv" | "pdf";

/**
 * One Export button that asks which file (Yamen, 2026-11-21: "press the
 * button, then it asks what type — CSV, PDF, Excel").
 *
 * The same three choices on every export in the product, in the same order:
 * Excel to work in, CSV to load into other software, PDF to print or send.
 * The file is fetched rather than linked, because a PDF is printed by the
 * worker and takes a moment: the button says so while it waits, and the file
 * is handed to the browser once the bytes arrive. The server decides when a
 * password is needed again (patient records); this asks for it and carries on
 * with the same file.
 */
export function ExportMenu({
  href,
  formats = ["xlsx", "csv", "pdf"],
  pdfHint,
  size = "md",
}: {
  /** The export's route, with its filters; `format` is added here. */
  href: string;
  formats?: ExportFormat[];
  /** What the PDF holds when it is not simply the table: "Full records, 400 at most". */
  pdfHint?: string;
  size?: "sm" | "md";
}) {
  const { t } = useI18n();
  const X = t.exports;
  const { toast } = useToast();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [reauthFor, setReauthFor] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const url = `${href}${href.includes("?") ? "&" : "?"}format=${format}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; count?: number; max?: number };
        if (body.error === "reauth_required") {
          setReauthFor(format);
          return;
        }
        toast(
          body.error === "too_many"
            ? X.tooMany.replace("{n}", String(body.count ?? "")).replace("{max}", String(body.max ?? ""))
            : body.error === "empty"
              ? X.empty
              : X.failed,
          "error"
        );
        return;
      }
      const name =
        decodeURIComponent(res.headers.get("content-disposition")?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] ?? "") ||
        `export.${format}`;
      const blob = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = blob;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blob);
      toast(X.done, "success");
    } catch {
      toast(X.failed, "error");
    } finally {
      setBusy(null);
    }
  };

  const items: Record<ExportFormat, { icon: React.ReactNode; label: string; hint: string }> = {
    xlsx: { icon: <FileSpreadsheet />, label: X.excel, hint: X.excelHint },
    csv: { icon: <FileText />, label: X.csv, hint: X.csvHint },
    pdf: { icon: <FileType2 />, label: X.pdf, hint: pdfHint ?? X.pdfHint },
  };

  return (
    <div data-export className="max-sm:grow">
      <Menu
        label={X.button}
        className="max-sm:w-full"
        buttonClassName={buttonClass({ variant: "outline", size, className: "max-sm:w-full" })}
        trigger={() => (
          <>
            <Download className="h-4 w-4" />
            {busy ? X.preparing : X.button}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </>
        )}
      >
        {(close) =>
          formats.map((f) => (
            <MenuItem
              key={f}
              icon={items[f].icon}
              hint={items[f].hint}
              disabled={busy !== null}
              onClick={() => {
                close();
                void run(f);
              }}
            >
              <span data-export-format={f}>{items[f].label}</span>
            </MenuItem>
          ))
        }
      </Menu>
      <ReauthPrompt
        open={reauthFor !== null}
        onClose={() => setReauthFor(null)}
        onVerified={() => {
          const f = reauthFor;
          setReauthFor(null);
          if (f) void run(f);
        }}
        t={t}
      />
    </div>
  );
}
