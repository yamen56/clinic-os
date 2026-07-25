"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { saveCustomFieldDefAction, deleteCustomFieldDefAction } from "../../patients/actions";
import { ListPlus, Pencil, Trash2 } from "lucide-react";

type Def = {
  id: string;
  key: string;
  label: string;
  label_ar: string | null;
  field_type: string;
  options: string[];
};

export function FieldsClient({ slug, isOwner, defs }: { slug: string; isOwner: boolean; defs: Def[] }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Partial<Def> | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      if (!editing?.label?.trim()) return;
      const r = await saveCustomFieldDefAction(slug, {
        id: editing.id,
        label: editing.label.trim(),
        labelAr: editing.label_ar?.trim() ?? "",
        fieldType: editing.field_type ?? "text",
        options: (editing.options ?? []).filter(Boolean),
      });
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.common.saved);
      setEditing(null);
      router.refresh();
    });

  return (
    <>
      <Card>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{t.fields.title}</h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t.fields.sub}</p>
          </div>
          {isOwner && (
            <Button size="sm" onClick={() => setEditing({ field_type: "text", options: [] })}>
              <ListPlus className="h-4 w-4" />
              {t.fields.addField}
            </Button>
          )}
        </div>
        {defs.length === 0 ? (
          <div className="p-5">
            <EmptyState title={t.fields.empty} body={t.fields.emptyBody} />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {defs.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">
                    {locale === "ar" ? d.label_ar || d.label : d.label}
                  </span>
                  <span className="ms-2 text-[12px] text-ink-400">
                    {(t.fields.types as Record<string, string>)[d.field_type] ?? d.field_type}
                  </span>
                </div>
                {isOwner && (
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setEditing(d)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteId(d.id)}>
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? t.common.edit : t.fields.addField}>
        {editing && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.fields.label} required>
                <Input value={editing.label ?? ""} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
              </Field>
              <Field label={t.fields.labelAr}>
                <Input dir="rtl" value={editing.label_ar ?? ""} onChange={(e) => setEditing({ ...editing, label_ar: e.target.value })} />
              </Field>
            </div>
            <Field label={t.fields.type}>
              <Select
                value={editing.field_type ?? "text"}
                onChange={(e) => setEditing({ ...editing, field_type: e.target.value })}
              >
                {Object.entries(t.fields.types).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            {editing.field_type === "select" && (
              <Field label={t.fields.options}>
                <Textarea
                  value={(editing.options ?? []).join("\n")}
                  onChange={(e) => setEditing({ ...editing, options: e.target.value.split("\n") })}
                />
              </Field>
            )}
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
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t.common.confirmDeleteTitle}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteId) {
            await deleteCustomFieldDefAction(slug, deleteId);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />
    </>
  );
}
