"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  saveFieldDefAction,
  deleteFieldDefAction,
  moveFieldDefAction,
  toggleFieldHiddenAction,
} from "./actions";
import {
  ListPlus,
  Pencil,
  Trash2,
  ChevronUp,
  ChevronDown,
  Copy,
  EyeOff,
  Plus,
  X,
} from "lucide-react";

type Def = {
  id: string;
  scope: "patient" | "context";
  key: string;
  label: string;
  label_ar: string | null;
  field_type: string;
  options: string[];
  is_required: boolean;
  is_system: boolean;
  hidden: boolean;
  show_in_profile: boolean;
  display_order: number;
};

export function FieldsClient({
  slug,
  isOwner,
  defs,
  usage,
}: {
  slug: string;
  isOwner: boolean;
  defs: Def[];
  usage: Record<string, number>;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Partial<Def> | null>(null);
  const [deleting, setDeleting] = useState<Def | null>(null);
  const [pending, start] = useTransition();

  const patientFields = defs.filter((d) => d.scope === "patient");
  const contextFields = defs.filter((d) => d.scope === "context");

  const save = () =>
    start(async () => {
      if (!editing?.label?.trim()) return;
      const r = await saveFieldDefAction(slug, {
        id: editing.id,
        label: editing.label.trim(),
        labelAr: editing.label_ar?.trim() ?? "",
        fieldType: editing.field_type ?? "text",
        options: (editing.options ?? []).map((o) => o.trim()).filter(Boolean),
        isRequired: !!editing.is_required,
        showInProfile: editing.show_in_profile !== false,
        hidden: !!editing.hidden,
      });
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.common.saved);
      setEditing(null);
      router.refresh();
    });

  const copyToken = async (key: string) => {
    await navigator.clipboard.writeText(`{{${key}}}`);
    toast(t.fields.copied);
  };

  const move = (id: string, direction: "up" | "down") =>
    start(async () => {
      await moveFieldDefAction(slug, id, direction);
      router.refresh();
    });

  const row = (d: Def, index: number, total: number) => (
    <li key={d.id} className={`flex items-center gap-2 px-5 py-3 ${d.hidden ? "opacity-55" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{locale === "ar" ? d.label_ar || d.label : d.label}</span>
          {d.is_system && <Badge status="neutral">{t.fields.builtIn}</Badge>}
          {d.hidden && (
            <Badge status="cancelled">
              <EyeOff className="h-3 w-3" />
              {t.fields.hidden}
            </Badge>
          )}
          {d.is_required && <span className="text-[11px] text-danger">*</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-400">
          {/* `max-w-full` and a breakable token: `{{patient.national_id}}` is
             183px in a mono face and the column beside the row controls is 168px
             on a phone, so without these the chip simply hangs outside it. */}
          <button
            onClick={() => copyToken(d.key)}
            className="mono inline-flex max-w-full items-center gap-1 rounded bg-sunken px-1.5 py-0.5 text-start transition-colors hover:text-brand-700"
            dir="ltr"
            title={t.fields.keyHint}
          >
            <span className="min-w-0 break-all">{`{{${d.key}}}`}</span>
            <Copy className="h-3 w-3 shrink-0" />
          </button>
          <span>{(t.fields.types as Record<string, string>)[d.field_type] ?? d.field_type}</span>
          {usage[d.key] > 0 && <span>{t.fields.inUse.replace("{n}", String(usage[d.key]))}</span>}
        </div>
      </div>
      {isOwner && (
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex flex-col">
            <button
              disabled={index === 0 || pending}
              onClick={() => move(d.id, "up")}
              aria-label={t.fields.moveUp}
              className="text-ink-300 transition-colors hover:text-ink-700 disabled:opacity-30"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              disabled={index === total - 1 || pending}
              onClick={() => move(d.id, "down")}
              aria-label={t.fields.moveDown}
              className="text-ink-300 transition-colors hover:text-ink-700 disabled:opacity-30"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
          <Toggle
            checked={!d.hidden}
            label={t.fields.hidden}
            onChange={(visible) =>
              start(async () => {
                await toggleFieldHiddenAction(slug, d.id, !visible);
                router.refresh();
              })
            }
          />
          <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setEditing(d)}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.common.delete}
            disabled={d.is_system}
            title={d.is_system ? t.fields.cannotDelete : undefined}
            onClick={() => setDeleting(d)}
          >
            <Trash2 className={`h-4 w-4 ${d.is_system ? "text-ink-300" : "text-danger"}`} />
          </Button>
        </div>
      )}
    </li>
  );

  return (
    // grid-cols-1 so the column floor is zero rather than the min-content width
    // of the widest card; see the note in automations-client.
    <div className="grid grid-cols-1 gap-4">
      <Card>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{t.fields.onRecord}</h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t.fields.onRecordSub}</p>
          </div>
          {isOwner && (
            <Button
              size="sm"
              onClick={() =>
                setEditing({ field_type: "text", options: [], show_in_profile: true })
              }
            >
              <ListPlus className="h-4 w-4" />
              {t.fields.addField}
            </Button>
          )}
        </div>
        {patientFields.length === 0 ? (
          <div className="p-5">
            <EmptyState title={t.fields.empty} body={t.fields.emptyBody} />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {patientFields.map((d, i) => row(d, i, patientFields.length))}
          </ul>
        )}
        <p className="border-t border-line px-5 py-3 text-[12px] text-ink-400">
          {t.fields.builtInHint}
        </p>
      </Card>

      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-[15px] font-semibold">{t.fields.fromContext}</h2>
          <p className="mt-0.5 text-[13px] text-ink-500">{t.fields.fromContextSub}</p>
        </div>
        <ul className="divide-y divide-line">
          {contextFields.map((d, i) => row(d, i, contextFields.length))}
        </ul>
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t.common.edit : t.fields.addField}
      >
        {editing && (
          <div className="grid gap-4">
            {editing.key && (
              <div className="rounded-lg border border-line bg-sunken px-3 py-2">
                <div className="text-[12px] font-semibold text-ink-500">{t.fields.key}</div>
                <code className="mono text-[13px]" dir="ltr">{`{{${editing.key}}}`}</code>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.fields.label} required>
                <Input
                  value={editing.label ?? ""}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                />
              </Field>
              <Field label={t.fields.labelAr}>
                <Input
                  dir="rtl"
                  value={editing.label_ar ?? ""}
                  onChange={(e) => setEditing({ ...editing, label_ar: e.target.value })}
                />
              </Field>
            </div>
            {editing.scope !== "context" && (
              <Field label={t.fields.type}>
                <Select
                  value={editing.field_type ?? "text"}
                  disabled={editing.is_system}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      field_type: e.target.value,
                      /*
                        A choice list opens with one empty row rather than with
                        nothing, so the first thing on screen is somewhere to
                        type. An empty editor with only an "add" button makes
                        the reader do a step the form could have done for them,
                        and blank rows are dropped on save anyway.
                      */
                      options:
                        e.target.value === "select" && !(editing.options ?? []).length
                          ? [""]
                          : editing.options,
                    })
                  }
                >
                  {(
                    ["text", "longtext", "number", "date", "phone", "email", "select", "checkbox"] as const
                  ).map((k) => (
                    <option key={k} value={k}>
                      {(t.fields.types as Record<string, string>)[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {editing.field_type === "select" && (
              <OptionsEditor
                options={editing.options ?? []}
                onChange={(options) => setEditing({ ...editing, options })}
              />
            )}
            {editing.scope !== "context" && (
              <div className="grid gap-3">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium">{t.fields.required}</span>
                  <Toggle
                    checked={!!editing.is_required}
                    onChange={(v) => setEditing({ ...editing, is_required: v })}
                  />
                </label>
                <label className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium">{t.fields.showInProfile}</span>
                  <Toggle
                    checked={editing.show_in_profile !== false}
                    onChange={(v) => setEditing({ ...editing, show_in_profile: v })}
                  />
                </label>
              </div>
            )}
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="block text-[13px] font-medium">{t.fields.hidden}</span>
                <span className="block text-[12px] text-ink-500">{t.fields.hiddenHint}</span>
              </span>
              <Toggle
                checked={!!editing.hidden}
                onChange={(v) => setEditing({ ...editing, hidden: v })}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                {t.common.cancel}
              </Button>
              <Button onClick={save} loading={pending} disabled={!editing.label?.trim()}>
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t.common.confirmDeleteTitle}
        body={t.fields.deleteWarn}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={() =>
          start(async () => {
            if (!deleting) return;
            const r = await deleteFieldDefAction(slug, deleting.id);
            if (r.error) toast(t.fields.cannotDelete, "error");
            setDeleting(null);
            router.refresh();
          })
        }
      />
    </div>
  );
}

/**
 * The choices behind a "choice list" field.
 *
 * This was one textarea, one choice per line, and the instruction was in the
 * label. Everything wrong with that is invisible until somebody uses it: there
 * is no sign the newlines are load-bearing until a clinic types "Private, Cash,
 * Insured" on one line and gets a dropdown with a single entry in it; you cannot
 * reorder without cut and paste; a duplicate is silent; and nothing on screen
 * resembles the dropdown it is going to produce.
 *
 * A row per choice fixes all four by looking like the answer. The one thing it
 * loses — pasting a list in from somewhere else — is given back by the paste
 * handler below, which is the only reason the textarea was ever nicer.
 */
function OptionsEditor({
  options,
  onChange,
}: {
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useI18n();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  /*
    Which row to put the cursor in once React has drawn it. A ref call at the
    call site cannot do this: the input added by `addAt` does not exist yet at
    the moment the row is added, so the focus has to wait for the render.
  */
  const [focusAt, setFocusAt] = useState<number | null>(null);
  useEffect(() => {
    if (focusAt === null) return;
    refs.current[focusAt]?.focus();
    setFocusAt(null);
  }, [focusAt]);

  const set = (next: string[], focus?: number) => {
    onChange(next);
    if (focus !== undefined) setFocusAt(focus);
  };
  const addAt = (i: number) => set([...options.slice(0, i), "", ...options.slice(i)], i);
  const remove = (i: number) =>
    set(
      options.filter((_, k) => k !== i),
      Math.max(0, i - 1)
    );
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j], next[i]];
    set(next, j);
  };

  /*
    The list this field already has, as text, is how most of these arrive — out
    of a spreadsheet column or an old form. A multi-line paste therefore becomes
    one row per line rather than one row containing newlines, which is what the
    browser would otherwise do and what nobody means. A single-line paste falls
    through to the browser untouched, so pasting one word into one box still
    behaves like pasting one word into one box.
  */
  const paste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const lines = e.clipboardData
      .getData("text")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    const next = [...options];
    next.splice(i, 1, ...lines);
    set(next, i + lines.length - 1);
  };

  const key = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // Enter means "and the next one", the way it does in every list editor
      // people already use. Prevented because the modal has a default button.
      e.preventDefault();
      addAt(i + 1);
    } else if (e.key === "Backspace" && options[i] === "" && options.length > 1) {
      e.preventDefault();
      remove(i);
    }
  };

  // A choice that repeats one above it. Flagged rather than blocked: it is
  // nearly always a typo mid-edit, and a form that refuses to hold what you
  // typed while you fix it is worse than one that tells you.
  const duplicate = (v: string, i: number) => {
    const s = v.trim().toLocaleLowerCase();
    return !!s && options.some((o, k) => k < i && o.trim().toLocaleLowerCase() === s);
  };

  /*
    Not wrapped in `Field`. That renders a <label> around its children, which is
    right for the one control it was built for and wrong here: a label owns a
    single control, so wrapping six of them associates the caption with the first
    choice and leaves the rest unlabelled. The caption below is plain markup in
    Field's own styling, and each row carries its own `aria-label`.
  */
  return (
    <div className="block">
      <span className="mb-1.5 flex items-baseline gap-1 text-[13px] font-semibold text-ink-900">
        {t.fields.options}
      </span>
      <div className="grid gap-2">
        {options.map((o, i) => {
          const dup = duplicate(o, i);
          return (
            <div key={i} className="flex items-center gap-2">
              {/* The position, so the row reads as "third in the dropdown"
                  rather than as a free-floating text box. `tnum` keeps the
                  column from shifting when the list passes nine. */}
              <span className="w-5 shrink-0 text-center text-[12px] text-ink-400 tnum">{i + 1}</span>
              <Input
                ref={(el) => {
                  refs.current[i] = el;
                }}
                value={o}
                className={dup ? "border-danger" : ""}
                placeholder={t.fields.optionPlaceholder}
                onChange={(e) => set(options.map((x, k) => (k === i ? e.target.value : x)))}
                onKeyDown={(e) => key(i, e)}
                onPaste={(e) => paste(i, e)}
                aria-label={`${t.fields.options} ${i + 1}`}
              />
              <div className="flex shrink-0 flex-col">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={t.fields.moveUp}
                  className="text-ink-300 transition-colors hover:text-ink-700 disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={i === options.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={t.fields.moveDown}
                  className="text-ink-300 transition-colors hover:text-ink-700 disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
              <button
                type="button"
                disabled={options.length === 1}
                onClick={() => remove(i)}
                aria-label={t.fields.removeOption}
                className="shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-400"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
        <div>
          <Button variant="outline" size="sm" onClick={() => addAt(options.length)}>
            <Plus className="h-4 w-4" />
            {t.fields.addOption}
          </Button>
        </div>
      </div>
      {options.some((o, i) => duplicate(o, i)) ? (
        <span className="mt-1 block text-xs text-danger">{t.fields.optionDuplicate}</span>
      ) : (
        <span className="mt-1 block text-xs text-ink-500">{t.fields.optionsHint}</span>
      )}
    </div>
  );
}
