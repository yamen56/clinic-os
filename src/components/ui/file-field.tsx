"use client";

import { useState } from "react";
import { Paperclip } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

/**
 * Choosing a file, in the app's own words.
 *
 * The browser's file input draws its own "Choose File · No file chosen" in the
 * browser's language, not the app's — so an Arabic screen showed two English
 * phrases in the middle of it, and on a phone the native control was a small
 * grey pill beside unreadable text (2026-11-14). The real input is still there
 * and still what is clicked, behind a label: the native picker, the camera
 * roll and Files on a phone, all keep working.
 */
export function FileField({
  accept,
  disabled,
  onFile,
  hint,
}: {
  accept?: string;
  disabled?: boolean;
  /** The file chosen, or null when the choice is cleared. */
  onFile: (file: File | null) => void;
  /** A line under the button, e.g. which formats are accepted. */
  hint?: string;
}) {
  const { t } = useI18n();
  const [name, setName] = useState<string | null>(null);

  return (
    <div>
      <label
        className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-ctl border border-dashed border-line-strong bg-surface px-3 py-2 transition-colors hover:border-brand-400 hover:bg-sunken focus-within:border-brand-600 ${
          disabled ? "pointer-events-none opacity-60" : ""
        }`}
      >
        <input
          type="file"
          accept={accept}
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setName(f?.name ?? null);
            onFile(f);
          }}
        />
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-ctl bg-brand-50 px-3 py-1.5 text-[13px] font-semibold text-brand-700">
          <Paperclip className="h-3.5 w-3.5" />
          {t.common.chooseFile}
        </span>
        <span dir="auto" className={`min-w-0 flex-1 truncate text-[13px] ${name ? "font-medium text-ink-900" : "text-ink-500"}`}>
          {name ?? t.common.noFileChosen}
        </span>
      </label>
      {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
