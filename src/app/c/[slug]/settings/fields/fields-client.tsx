"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, Toggle } from "@/components/ui/input";
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
import { ListPlus, Pencil, Trash2, ChevronUp, ChevronDown, Copy, EyeOff } from "lucide-react";

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
          <button
            onClick={() => copyToken(d.key)}
            className="mono inline-flex items-center gap-1 rounded bg-sunken px-1.5 py-0.5 transition-colors hover:text-brand-700"
            dir="ltr"
            title={t.fields.keyHint}
          >
            {`{{${d.key}}}`}
            <Copy className="h-3 w-3" />
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
    <div className="grid gap-4">
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
                  onChange={(e) => setEditing({ ...editing, field_type: e.target.value })}
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
              <Field label={t.fields.options}>
                <Textarea
                  value={(editing.options ?? []).join("\n")}
                  onChange={(e) => setEditing({ ...editing, options: e.target.value.split("\n") })}
                />
              </Field>
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
