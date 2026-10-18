"use client";

import { useRef, useState, useTransition } from "react";
import { FileText, ImageIcon, Paperclip, Plus, Trash2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Input, NumberInput, Select, Textarea, Toggle } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DOCUMENT_STATUSES,
  PATIENT_SOURCES,
  PATIENT_STATUSES,
  RULE_GROUPS,
  RULE_NEEDS,
  newRule,
  type Ctx,
  type Rule,
  type RuleKind,
} from "@/lib/automation/catalog";
import { availableGroups, renderMessage, sampleContext, unavailableVariables } from "@/lib/automation/variables";
import { fill, type Lookups } from "../flow-meta";
import { previewMessageAction } from "../actions";

/* -------------------------------------------------------------------------
   Small controls
   ------------------------------------------------------------------------- */

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] font-semibold text-ink-900">{title}</div>
      {children}
      {hint && <p className="mt-1.5 text-[12px] leading-snug text-ink-500">{hint}</p>}
    </div>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
  single,
}: {
  options: { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  single?: boolean;
}) {
  return (
    <div className="flex max-h-48 flex-wrap gap-1.5 overflow-auto">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(single ? [o.value] : on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
              on ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:border-line-strong"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid gap-1 rounded-ctl bg-sunken p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-w-0 rounded-md px-2 py-1.5 text-[12px] font-medium leading-tight transition-colors ${
            value === o.value ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-900"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="text-[13px] text-ink-700">{label}</span>
    </div>
  );
}

/** Words typed one at a time; Enter or a comma adds one. */
export function KeywordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const add = () => {
    const words = draft
      .split(/[,،\n]/)
      .map((w) => w.trim())
      .filter(Boolean)
      .filter((w) => !value.includes(w));
    if (words.length) onChange([...value, ...words].slice(0, 30));
    setDraft("");
  };
  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((w) => (
            <span key={w} className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1 text-[12px] font-medium text-ink-900">
              {w}
              <button
                type="button"
                aria-label={t.automations.flow.remove}
                onClick={() => onChange(value.filter((x) => x !== w))}
                className="text-ink-400 hover:text-danger"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <Button type="button" variant="outline" size="md" onClick={add} disabled={!draft.trim()}>
          {t.automations.flow.add}
        </Button>
      </div>
    </div>
  );
}

export function AmountUnit({
  amount,
  unit,
  onChange,
  min = 0,
  units = ["minutes", "hours", "days"],
}: {
  amount: number;
  unit: string;
  onChange: (amount: number, unit: string) => void;
  min?: number;
  units?: string[];
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-2">
      <NumberInput dir="ltr" min={min} max={525600} value={amount} fallback={min} onChange={(v) => onChange(v, unit)} />
      <Select value={unit} onChange={(e) => onChange(amount, e.target.value)}>
        {units.map((u) => (
          <option key={u} value={u}>
            {(t.automations.flow.units as Record<string, string>)[u]}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function TagCombo({
  value,
  onChange,
  tags,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  tags: string[];
  placeholder?: string;
}) {
  const id = useRef(`tags-${Math.random().toString(36).slice(2)}`).current;
  return (
    <>
      <Input value={value} placeholder={placeholder} list={id} maxLength={40} onChange={(e) => onChange(e.target.value)} />
      <datalist id={id}>
        {tags.map((tg) => (
          <option key={tg} value={tg} />
        ))}
      </datalist>
    </>
  );
}

export function MemberSelect({
  value,
  onChange,
  members,
}: {
  value: string;
  onChange: (v: string) => void;
  members: Lookups["members"];
}) {
  const { t } = useI18n();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t.automations.flow.choose}</option>
      {members.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.is_owner ? ` · ${t.automations.alertRoles.owner}` : ` · ${(t.automations.alertRoles as Record<string, string>)[m.role] ?? m.role}`}
        </option>
      ))}
    </Select>
  );
}

/* -------------------------------------------------------------------------
   The message composer
   ------------------------------------------------------------------------- */

export type Media = { path: string; kind: "image" | "document"; name: string; mime: string } | null;

export function MessageComposer({
  slug,
  value,
  onChange,
  media,
  onMedia,
  provides,
  hasReplyStep,
  allowMedia = true,
  rows = 6,
}: {
  slug: string;
  value: string;
  onChange: (v: string) => void;
  media?: Media;
  onMedia?: (m: Media) => void;
  provides: Ctx[];
  hasReplyStep: boolean;
  allowMedia?: boolean;
  rows?: number;
}) {
  const { t, locale } = useI18n();
  const f = t.automations.flow;
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(false);
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [real, setReal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const groups = availableGroups(provides, hasReplyStep);
  const missing = unavailableVariables(value, provides, hasReplyStep);

  const insert = (token: string) => {
    const el = ref.current;
    if (!el) return onChange(value + token);
    const at = el.selectionStart ?? value.length;
    const next = value.slice(0, at) + token + value.slice(el.selectionEnd ?? at);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(false);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/c/${slug}/automations/media`, { method: "POST", body });
      if (!res.ok) throw new Error(String(res.status));
      const m = (await res.json()) as { path: string; name: string; kind: "image" | "document"; mime: string };
      onMedia?.({ path: m.path, name: m.name, kind: m.kind, mime: m.mime });
    } catch {
      setUploadError(true);
    } finally {
      setUploading(false);
    }
  };

  const refreshReal = (p: { id: string; name: string }, text = value) =>
    start(async () => {
      const r = await previewMessageAction(slug, { template: text, patientId: p.id });
      setReal(r.text ?? null);
    });

  const preview = patient && real !== null ? real : renderMessage(value, sampleContext(locale === "ar" ? "ar" : "en"));

  return (
    <div className="grid gap-3">
      <Textarea
        ref={ref}
        rows={rows}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (patient) setReal(null);
        }}
        className="min-h-32"
      />
      <div className="rounded-ctl bg-sunken p-2.5">
        <div className="grid gap-2">
          {groups.map((g) => (
            <div key={g.group} className="flex flex-wrap items-center gap-1.5">
              <span className="w-full text-[11px] font-semibold text-ink-500">
                {(f.varGroups as Record<string, string>)[g.group]}
              </span>
              {g.vars.map((v) => (
                <button
                  key={v}
                  type="button"
                  dir="ltr"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(`{{${g.group}.${v}}}`)}
                  className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink-700 hover:border-brand-600 hover:text-brand-700"
                >
                  {`${g.group}.${v}`}
                </button>
              ))}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-snug text-ink-500">{f.composeHint}</p>
      </div>
      {missing.length > 0 && (
        <p className="rounded-md bg-st-noshow-soft px-2.5 py-1.5 text-[12px] text-st-noshow">
          {missing.map((v) => fill(f.unavailableVar, { v: `{{${v}}}` })).join(" · ")}
        </p>
      )}

      {allowMedia && onMedia && (
        <div>
          <div className="mb-1.5 text-[13px] font-semibold text-ink-900">{f.attachment}</div>
          {media ? (
            <div className="flex items-center gap-2 rounded-ctl border border-line bg-surface px-3 py-2">
              {media.kind === "image" ? <ImageIcon className="h-4 w-4 text-ink-500" /> : <FileText className="h-4 w-4 text-ink-500" />}
              <span className="min-w-0 flex-1 truncate text-[13px]">{media.name}</span>
              <button type="button" onClick={() => onMedia(null)} className="text-[12px] font-medium text-danger hover:underline">
                {f.remove}
              </button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <Paperclip className="h-4 w-4" />
              {uploading ? f.uploading : f.attach}
            </Button>
          )}
          {uploadError && <p className="mt-1.5 text-[12px] text-danger">{f.uploadFailed}</p>}
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </div>
      )}

      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-ink-900">{f.preview}</span>
          <PatientPicker
            slug={slug}
            value={patient}
            onPick={(p) => {
              setPatient(p);
              setReal(null);
              if (p) refreshReal(p);
            }}
          />
        </div>
        <div className="rounded-xl bg-sunken p-3">
          <div
            dir="auto"
            className="ms-auto max-w-[92%] whitespace-pre-wrap break-words rounded-lg rounded-se-none bg-st-confirmed-soft px-3 py-2 text-[13px] leading-relaxed text-ink-900 shadow-card"
          >
            {media && (
              <div className="mb-1.5 flex items-center gap-1.5 rounded bg-white/60 px-2 py-1 text-[12px] text-ink-700">
                {media.kind === "image" ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                <span className="truncate">{media.name}</span>
              </div>
            )}
            {pending ? "…" : preview || "—"}
          </div>
        </div>
        <p className="mt-1 text-[11px] text-ink-500">{patient ? patient.name : f.previewSample}</p>
      </div>
    </div>
  );
}

function PatientPicker({
  slug,
  value,
  onPick,
}: {
  slug: string;
  value: { id: string; name: string } | null;
  onPick: (p: { id: string; name: string } | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string }[]>([]);
  const seq = useRef(0);

  if (value) {
    return (
      <button type="button" onClick={() => onPick(null)} className="text-[12px] font-medium text-brand-700 hover:underline">
        {t.automations.flow.previewSample}
      </button>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-[12px] font-medium text-brand-700 hover:underline">
        {t.automations.flow.previewFor}
      </button>
    );
  }
  return (
    <div className="relative w-full">
      <Input
        autoFocus
        value={q}
        placeholder={t.automations.flow.previewPick}
        onChange={async (e) => {
          const v = e.target.value;
          setQ(v);
          const mine = ++seq.current;
          if (v.trim().length < 2) return setResults([]);
          const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(v)}`);
          if (res.ok && mine === seq.current) setResults(((await res.json()).results ?? []).slice(0, 6));
        }}
      />
      {results.length > 0 && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 grid gap-0.5 rounded-ctl border border-line bg-surface p-1 shadow-pop">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onPick({ id: r.id, name: r.full_name });
                setOpen(false);
                setQ("");
                setResults([]);
              }}
              className="rounded-md px-2.5 py-1.5 text-start text-[13px] hover:bg-sunken"
            >
              {r.full_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   If / else
   ------------------------------------------------------------------------- */

export function ConditionEditor({
  match,
  rules,
  onChange,
  provides,
  lookups,
}: {
  match: "all" | "any";
  rules: Rule[];
  onChange: (match: "all" | "any", rules: Rule[]) => void;
  provides: Ctx[];
  lookups: Lookups;
}) {
  const { t, locale } = useI18n();
  const f = t.automations.flow;
  const usable = (k: RuleKind) => !RULE_NEEDS[k] || provides.includes(RULE_NEEDS[k]!);
  const firstUsable = RULE_GROUPS.flatMap((g) => g.kinds).find(usable) ?? "replied";
  const set = (i: number, patch: Partial<Rule>) => onChange(match, rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="grid gap-3">
      <Segmented
        value={match}
        onChange={(m) => onChange(m, rules)}
        options={[
          { value: "all", label: f.match.all },
          { value: "any", label: f.match.any },
        ]}
      />
      {rules.map((r, i) => (
        <div key={i} className="grid gap-2 rounded-xl border border-line bg-subtle p-3">
          <div className="flex items-center gap-2">
            <Select
              value={r.kind}
              onChange={(e) => {
                const kind = e.target.value as RuleKind;
                set(i, { ...newRule(kind), negate: r.negate });
              }}
            >
              {RULE_GROUPS.map((g) => (
                <optgroup key={g.group} label={(f.ruleGroups as Record<string, string>)[g.group]}>
                  {g.kinds.map((k) => (
                    <option key={k} value={k} disabled={!usable(k)}>
                      {(f.rules as Record<string, string>)[k]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <button
              type="button"
              aria-label={t.common.delete}
              onClick={() => onChange(match, rules.filter((_, j) => j !== i))}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl text-ink-400 hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <RuleValue rule={r} onChange={(patch) => set(i, patch)} lookups={lookups} locale={locale} />
          <Check checked={r.negate} onChange={(v) => set(i, { negate: v })} label={f.isNot} />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange(match, [...rules, newRule(firstUsable)])} disabled={rules.length >= 10}>
        <Plus className="h-4 w-4" />
        {f.addRule}
      </Button>
    </div>
  );
}

function RuleValue({
  rule: r,
  onChange,
  lookups,
  locale,
}: {
  rule: Rule;
  onChange: (patch: Partial<Rule>) => void;
  lookups: Lookups;
  locale: string;
}) {
  const { t } = useI18n();
  const f = t.automations.flow;
  const num = (v: number | null, key: "number" | "number2", placeholder: string) => (
    <Input
      dir="ltr"
      type="number"
      inputMode="decimal"
      placeholder={placeholder}
      value={v ?? ""}
      onChange={(e) => onChange({ [key]: e.target.value === "" ? null : Number(e.target.value) } as Partial<Rule>)}
    />
  );
  const chips = (options: { value: string; label: string }[]) => (
    <Chips options={options} value={r.values} onChange={(values) => onChange({ values })} />
  );
  const name = (s: { name: string; name_ar: string | null }) => (locale === "ar" ? s.name_ar || s.name : s.name);

  switch (r.kind) {
    case "has_tag":
      return <TagCombo value={r.value} onChange={(value) => onChange({ value })} tags={lookups.tags} />;
    case "gender":
      return chipsSingle(
        [
          { value: "male", label: f.genders.male },
          { value: "female", label: f.genders.female },
        ],
        r.value,
        (value) => onChange({ value })
      );
    case "age_between":
      return (
        <div className="grid grid-cols-2 gap-2">
          {num(r.number, "number", f.from)}
          {num(r.number2, "number2", f.to)}
        </div>
      );
    case "patient_source":
      return chips(PATIENT_SOURCES.map((s) => ({ value: s, label: (f.patientSources as Record<string, string>)[s] })));
    case "patient_status":
      return chips(PATIENT_STATUSES.map((s) => ({ value: s, label: (f.patientStatuses as Record<string, string>)[s] })));
    case "custom_field":
      if (!lookups.customFields.length) return <p className="text-[12px] text-ink-500">{f.noCustomFields}</p>;
      return (
        <div className="grid gap-2">
          <Select value={r.key} onChange={(e) => onChange({ key: e.target.value })}>
            <option value="">{f.choose}</option>
            {lookups.customFields.map((cf) => (
              <option key={cf.key} value={cf.key}>
                {locale === "ar" ? cf.label_ar || cf.label : cf.label}
              </option>
            ))}
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Select value={r.op} onChange={(e) => onChange({ op: e.target.value as Rule["op"] })}>
              {(["equals", "contains", "empty", "not_empty"] as const).map((op) => (
                <option key={op} value={op}>
                  {f.ops[op]}
                </option>
              ))}
            </Select>
            {(r.op === "equals" || r.op === "contains") && (
              <Input value={r.value} placeholder={f.value} onChange={(e) => onChange({ value: e.target.value })} />
            )}
          </div>
        </div>
      );
    case "visits_at_least":
    case "invoice_balance_above":
      return num(r.number, "number", "0");
    case "appointment_status":
      return chips(
        ["pending_approval", "scheduled", "confirmed", "completed", "no_show", "cancelled"].map((s) => ({
          value: s,
          label: (t.calendar.statuses as Record<string, string>)[s] ?? s,
        }))
      );
    case "appointment_service":
      return chips(lookups.services.map((s) => ({ value: s.id, label: name(s) })));
    case "appointment_doctor":
      return chips(lookups.members.filter((m) => m.role === "doctor").map((m) => ({ value: m.id, label: m.name })));
    case "reply_contains":
      return <KeywordInput value={r.values} onChange={(values) => onChange({ values })} />;
    case "document_status":
      return chips(DOCUMENT_STATUSES.map((s) => ({ value: s, label: (f.documentStatuses as Record<string, string>)[s] })));
    case "weekday":
      return chips(
        [6, 7, 1, 2, 3, 4, 5].map((d) => ({ value: String(d), label: (t.automations.weekdays as Record<string, string>)[d] }))
      );
    case "time_between":
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input type="time" dir="ltr" value={r.value} onChange={(e) => onChange({ value: e.target.value })} />
          <Input type="time" dir="ltr" value={r.value2} onChange={(e) => onChange({ value2: e.target.value })} />
        </div>
      );
  }
  return null;
}

function chipsSingle(options: { value: string; label: string }[], value: string, onChange: (v: string) => void) {
  return <Chips single options={options} value={value ? [value] : []} onChange={(v) => onChange(v[0] ?? "")} />;
}

/* -------------------------------------------------------------------------
   Wait for a reply
   ------------------------------------------------------------------------- */

export type ReplyOption = { label: string; keywords: string[] };

export function ReplyOptionsEditor({
  options,
  onChange,
}: {
  options: ReplyOption[];
  /** `removed` is the index taken out, so the edges after it can move up. */
  onChange: (options: ReplyOption[], removed: number | null) => void;
}) {
  const { t } = useI18n();
  const f = t.automations.flow;
  return (
    <div className="grid gap-2.5">
      {options.map((o, i) => (
        <div key={i} className="grid gap-2 rounded-xl border border-line bg-subtle p-3">
          <div className="flex items-center gap-2">
            <Input
              value={o.label}
              maxLength={40}
              placeholder={fill(f.answerN, { n: i + 1 })}
              onChange={(e) => onChange(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)), null)}
            />
            <button
              type="button"
              aria-label={t.common.delete}
              onClick={() => onChange(options.filter((_, j) => j !== i), i)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-ctl text-ink-400 hover:bg-danger-soft hover:text-danger"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <KeywordInput
            value={o.keywords}
            placeholder={f.answerKeywords}
            onChange={(keywords) => onChange(options.map((x, j) => (j === i ? { ...x, keywords } : x)), null)}
          />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={options.length >= 6}
        onClick={() => onChange([...options, { label: "", keywords: [] }], null)}
      >
        <Plus className="h-4 w-4" />
        {f.addAnswer}
      </Button>
    </div>
  );
}
