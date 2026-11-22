"use client";

import { DETAILS_SUFFIX } from "@/lib/esign/questions";

export type QuestionWords = { yes: string; no: string; tellUsMore: string; male: string; female: string };

/**
 * One answer, in the shape the question asks for — on a phone, so every
 * choice is a 44px target and a yes/no is two buttons, not a dropdown.
 *
 * Answers live in one flat record: the key holds the answer, and a yes/no's
 * explanation rides beside it under `key + DETAILS_SUFFIX`.
 */
export function QuestionInput({
  qkey,
  type,
  options,
  answers,
  onChange,
  words,
}: {
  qkey: string;
  type: string;
  options: string[];
  answers: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  words: QuestionWords;
}) {
  const value = answers[qkey];
  const set = (v: unknown) => onChange({ ...answers, [qkey]: v });
  const field = "h-11 w-full rounded-ctl border border-line bg-surface px-3 text-[0.9375rem]";
  const pill = (on: boolean) =>
    `inline-flex min-h-11 items-center justify-center rounded-ctl border-2 px-4 text-[0.9375rem] font-medium transition-colors ${
      on ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:border-line-strong"
    }`;

  if (type === "yes_no") {
    return (
      <div className="grid gap-2" data-question={qkey}>
        <div className="grid grid-cols-2 gap-2">
          {(["yes", "no"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={value === v} className={pill(value === v)} onClick={() => set(v)}>
              {v === "yes" ? words.yes : words.no}
            </button>
          ))}
        </div>
        {value === "yes" && (
          <textarea
            value={String(answers[qkey + DETAILS_SUFFIX] ?? "")}
            placeholder={words.tellUsMore}
            onChange={(e) => onChange({ ...answers, [qkey + DETAILS_SUFFIX]: e.target.value })}
            className="min-h-20 w-full rounded-ctl border border-line bg-surface px-3 py-2 text-[0.9375rem]"
          />
        )}
      </div>
    );
  }

  // Choose one: a gender, a marital status. Few options read better as buttons.
  if (type === "select") {
    const opts = qkey === "patient.gender" && !options.length ? ["male", "female"] : options;
    const label = (o: string) => (qkey === "patient.gender" ? (o === "male" ? words.male : o === "female" ? words.female : o) : o);
    if (opts.length && opts.length <= 6) {
      return (
        <div className="flex flex-wrap gap-2" data-question={qkey}>
          {opts.map((o) => (
            <button key={o} type="button" aria-pressed={value === o} className={pill(value === o)} onClick={() => set(o)}>
              {label(o)}
            </button>
          ))}
        </div>
      );
    }
    return (
      <select value={String(value ?? "")} onChange={(e) => set(e.target.value)} className={field} data-question={qkey}>
        <option value="">—</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {label(o)}
          </option>
        ))}
      </select>
    );
  }

  // Tick any.
  if (type === "choices") {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="grid gap-1.5" data-question={qkey}>
        {options.map((o) => (
          <label key={o} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-ctl border border-line bg-surface px-3 has-[:checked]:border-brand-500">
            <input
              type="checkbox"
              checked={picked.includes(o)}
              onChange={(e) => set(e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))}
              className="h-5 w-5 shrink-0 accent-brand-600"
            />
            <span className="text-[0.9375rem]">{o}</span>
          </label>
        ))}
      </div>
    );
  }

  if (type === "checkbox") {
    return (
      <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} className="h-5 w-5 accent-brand-600" data-question={qkey} />
    );
  }
  if (type === "longtext") {
    return (
      <textarea
        value={String(value ?? "")}
        onChange={(e) => set(e.target.value)}
        className="min-h-20 w-full rounded-ctl border border-line bg-surface px-3 py-2 text-[0.9375rem]"
        data-question={qkey}
      />
    );
  }
  return (
    <input
      type={type === "number" ? "number" : type === "date" ? "date" : type === "email" ? "email" : type === "phone" ? "tel" : "text"}
      dir={type === "phone" || type === "email" || type === "number" ? "ltr" : undefined}
      value={String(value ?? "")}
      onChange={(e) => set(e.target.value)}
      className={field}
      data-question={qkey}
    />
  );
}
