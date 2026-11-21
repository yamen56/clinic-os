"use client";

import { createContext, useContext, useId, useState } from "react";
import { CircleHelp } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

/*
  Explanations that wait to be asked for.

  Settings explained every field and every card in a sentence, and the
  sentences were most of what there was to read: Yamen, 2026-11-21 — "to go to
  the team and staff I have to read all of that; it's overwhelming, specially
  for people who don't have experience in these types of software". Inside
  FoldHints a field's hint and a card's description fold behind a small "?"
  beside the name, and open in place on a tap: the page reads as names and
  controls, and the sentence is one tap away for whoever needs it. Outside it
  — forms elsewhere, where a hint is usually a warning in context — nothing
  changes.
*/
const Folded = createContext(false);

export function FoldHints({ children }: { children: React.ReactNode }) {
  return <Folded.Provider value>{children}</Folded.Provider>;
}

export function useFoldedHints(): boolean {
  return useContext(Folded);
}

/**
 * The "?" itself. A span with the button role rather than a <button>: it sits
 * inside a field's <label>, and a button there would become what the label
 * labels — clicking the field's name would toggle the hint instead of focusing
 * the input.
 */
export function HintToggle({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  const { t } = useI18n();
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={t.common.moreInfo}
      data-hint-toggle
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={`relative inline-grid h-4 w-4 shrink-0 cursor-pointer place-items-center self-center rounded-full transition-colors before:absolute before:-inset-3 before:content-[''] ${
        open ? "text-ink-700" : "text-ink-300 hover:text-ink-500"
      }`}
    >
      <CircleHelp className="h-3.5 w-3.5" strokeWidth={2} />
    </span>
  );
}

/**
 * A card's title and the sentence under it — folded behind the "?" inside
 * FoldHints, as it always was outside.
 */
export function CardTitle({ title, sub }: { title: React.ReactNode; sub?: React.ReactNode }) {
  const folded = useFoldedHints();
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!folded || !sub) {
    return (
      <>
        <h3 className="font-display text-base font-semibold text-ink-900">{title}</h3>
        {sub && <p className="mt-0.5 text-[0.8125rem] text-ink-500">{sub}</p>}
      </>
    );
  }
  return (
    <>
      <h3 className="font-display flex items-center gap-1.5 text-base font-semibold text-ink-900">
        <span className="min-w-0">{title}</span>
        <HintToggle open={open} onToggle={() => setOpen((o) => !o)} controls={id} />
      </h3>
      <p id={id} hidden={!open} className="mt-0.5 text-[0.8125rem] text-ink-500">
        {sub}
      </p>
    </>
  );
}
