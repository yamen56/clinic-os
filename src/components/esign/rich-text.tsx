"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/client";
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Heading2,
  Minus,
  Table as TableIcon,
  RemoveFormatting,
} from "lucide-react";

/**
 * A small rich-text field for document bodies.
 *
 * Built on `contentEditable` plus `execCommand`. That API is formally deprecated
 * and still the only way to get real rich text with no dependency, and a consent
 * form needs exactly what it does well: bold, headings, numbered clauses, a rule,
 * an occasional table. Everything it produces goes through the server-side
 * allowlist sanitizer before it is stored, so what the browser emits does not
 * have to be trusted.
 *
 * The editor is uncontrolled on purpose. Writing `innerHTML` on every keystroke
 * destroys and rebuilds the DOM under the caret, which moves the cursor to the
 * start — the single most common way a rich-text field ends up unusable.
 */
export function RichText({
  defaultValue,
  onChange,
  dir,
  placeholder,
  minHeightClass = "min-h-72",
  toolbarExtra,
}: {
  defaultValue: string;
  onChange: (html: string) => void;
  dir?: "rtl" | "ltr";
  placeholder?: string;
  minHeightClass?: string;
  toolbarExtra?: React.ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== defaultValue) el.innerHTML = defaultValue;
    // Only on mount, and when the caller swaps to a different body (language
    // tab). Re-running on every parent render would fight the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValue === undefined]);

  const exec = (command: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, value);
    onChange(ref.current?.innerHTML ?? "");
  };

  const insertHtml = (html: string) => {
    ref.current?.focus();
    document.execCommand("insertHTML", false, html);
    onChange(ref.current?.innerHTML ?? "");
  };

  const buttons: { icon: React.ReactNode; label: string; run: () => void }[] = [
    { icon: <Bold className="h-4 w-4" />, label: "Bold", run: () => exec("bold") },
    { icon: <Italic className="h-4 w-4" />, label: "Italic", run: () => exec("italic") },
    { icon: <Underline className="h-4 w-4" />, label: "Underline", run: () => exec("underline") },
    {
      icon: <Heading2 className="h-4 w-4" />,
      label: "Heading",
      run: () => exec("formatBlock", "<h2>"),
    },
    { icon: <List className="h-4 w-4" />, label: "Bullets", run: () => exec("insertUnorderedList") },
    {
      icon: <ListOrdered className="h-4 w-4" />,
      label: "Numbered",
      run: () => exec("insertOrderedList"),
    },
    { icon: <Minus className="h-4 w-4" />, label: "Divider", run: () => insertHtml("<hr />") },
    {
      icon: <TableIcon className="h-4 w-4" />,
      label: "Table",
      run: () =>
        insertHtml(
          "<table><tbody><tr><th>&nbsp;</th><th>&nbsp;</th></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br /></p>"
        ),
    },
    {
      icon: <RemoveFormatting className="h-4 w-4" />,
      label: "Clear formatting",
      run: () => exec("removeFormat"),
    },
  ];

  return (
    <div className="rounded-ctl border border-line bg-surface focus-within:border-brand-600">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1.5">
        {buttons.map((b, i) => (
          <button
            key={i}
            type="button"
            aria-label={b.label}
            title={b.label}
            // Mouse-down rather than click: clicking a toolbar button blurs the
            // editable first, and the selection execCommand needs is gone by then.
            onMouseDown={(e) => {
              e.preventDefault();
              b.run();
            }}
            className="rounded-md p-1.5 text-ink-500 transition-colors hover:bg-sunken hover:text-ink-900"
          >
            {b.icon}
          </button>
        ))}
        {toolbarExtra && <span className="ms-auto flex items-center gap-1">{toolbarExtra}</span>}
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        dir={dir}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder ?? t.docTemplates.bodyEn}
        data-placeholder={placeholder}
        onInput={() => onChange(ref.current?.innerHTML ?? "")}
        onBlur={() => onChange(ref.current?.innerHTML ?? "")}
        className={`doc-editor ${minHeightClass} w-full overflow-y-auto px-3.5 py-3 text-sm leading-relaxed outline-none`}
      />
    </div>
  );
}

/** Inserts a merge token at the caret of the nearest editable ancestor. */
export function insertTokenAtCaret(token: string): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest(
    "[contenteditable='true']"
  );
  if (!el) return false;
  (el as HTMLElement).focus();
  document.execCommand("insertText", false, `{{${token}}}`);
  return true;
}
