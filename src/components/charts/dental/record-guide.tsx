"use client";

/*
  How to record on the chart, in one screen (2026-11-26: "make it obvious for
  the doctor and understandable how to record everything").

  Four steps — the tooth, what it is, the treatment, its steps — then the
  things a doctor looks for once: the whole mouth, many teeth, a mistake,
  another day, an emergency. Each colour of the chart with what it means.
  Opened from the chart's toolbar; nothing in it changes anything.
*/

import { CalendarDays, Hand, ListChecks, ListOrdered, Paintbrush, Plus, Search, Siren, Undo2, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import type { Paint } from "@/lib/charts/dental/state";
import { PaintSwatch } from "./tooth-art";

const PAINTS: Paint[] = ["done", "planned", "progress", "existing", "finding"];

export function RecordGuide() {
  const { t } = useI18n();
  const T = t.dental;
  const G = T.guide;
  const steps: { icon: LucideIcon; title: string; body: string }[] = [
    { icon: Hand, title: G.s1, body: G.s1b },
    { icon: ListChecks, title: G.s2, body: G.s2b },
    { icon: Search, title: G.s3, body: G.s3b },
    { icon: ListOrdered, title: G.s4, body: G.s4b },
  ];
  const tips: { icon: LucideIcon; text: string }[] = [
    { icon: Plus, text: G.mouth },
    { icon: Paintbrush, text: G.brush },
    { icon: Undo2, text: G.undo },
    { icon: CalendarDays, text: G.day },
    { icon: Siren, text: G.emergency },
  ];
  return (
    <div className="grid gap-5" data-record-guide-body>
      <ol className="grid gap-3">
        {steps.map(({ icon: Icon, title, body }, i) => (
          <li key={title} className="flex gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 font-display text-[0.875rem] font-bold text-on-brand tnum">{i + 1}</span>
            <div className="min-w-0 pt-0.5">
              <div className="flex items-center gap-1.5 text-[0.9375rem] font-semibold text-ink-900">
                <Icon className="h-4 w-4 text-ink-500" />
                {title}
              </div>
              <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-ink-700">{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <section>
        <h4 className="mb-2 text-[0.8125rem] font-semibold text-ink-900">{G.colours}</h4>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {PAINTS.map((p) => (
            <li key={p} className="flex items-center gap-2 text-[0.8125rem] text-ink-700">
              <PaintSwatch paint={p} size={18} />
              <span className="font-semibold text-ink-900">{T.status[p]}</span>
              <span className="text-ink-500">{T.statusHint[p]}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="mb-2 text-[0.8125rem] font-semibold text-ink-900">{G.alsoTitle}</h4>
        <ul className="grid gap-2">
          {tips.map(({ icon: Icon, text }) => (
            <li key={text} className="flex gap-2.5 text-[0.8125rem] leading-relaxed text-ink-700">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
