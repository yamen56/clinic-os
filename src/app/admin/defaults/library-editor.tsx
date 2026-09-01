"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/client-dict";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { RichText } from "@/components/esign/rich-text";
import { saveLibraryTemplateAction, deleteLibraryTemplateAction } from "../actions";
import { Library, Pencil, Trash2, Plus } from "lucide-react";

type Entry = {
  id: string;
  key: string;
  name: string;
  name_ar: string;
  category: string;
  body: string;
  body_ar: string;
  sort: number;
  active: boolean;
  copies: number;
};

/**
 * The agency's starter forms.
 *
 * Editing one here never touches a clinic that already has a copy — copies are
 * made at clinic creation and belong to the clinic from then on. `copies` is
 * shown so that is obvious rather than assumed.
 */
export function LibraryEditor({ entries, locale }: { entries: Entry[]; locale: Locale }) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<Partial<Entry> | null>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [tab, setTab] = useState<"ar" | "en">("ar");

  const save = () =>
    start(async () => {
      if (!editing?.name?.trim() || !editing.key?.trim()) return;
      const r = await saveLibraryTemplateAction({
        id: editing.id,
        key: editing.key.trim(),
        name: editing.name.trim(),
        nameAr: editing.name_ar?.trim() ?? "",
        category: editing.category ?? "consent",
        body: editing.body ?? "",
        bodyAr: editing.body_ar ?? "",
        sort: Number(editing.sort ?? 100),
        active: editing.active !== false,
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
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Library className="h-4 w-4 text-ink-400" />
              {t.docTemplates.fromLibrary}
            </span>
          }
          sub={t.docTemplates.fromLibrarySub}
          action={
            <Button
              size="sm"
              onClick={() =>
                setEditing({ category: "consent", active: true, sort: 100, body: "", body_ar: "" })
              }
            >
              <Plus className="h-4 w-4" />
              {t.docTemplates.addTemplate}
            </Button>
          }
        />
        <ul className="divide-y divide-line">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {locale === "ar" ? e.name_ar || e.name : e.name}
                  </span>
                  {!e.active && <Badge status="cancelled">{t.docTemplates.inactive}</Badge>}
                  {e.copies > 0 && (
                    <Badge status="neutral">{t.signerRoles.inUse.replace("{n}", String(e.copies))}</Badge>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-400">
                  <code className="mono" dir="ltr">
                    {e.key}
                  </code>
                  <span>
                    {(t.docTemplates.categories as Record<string, string>)[e.category] ?? e.category}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.common.edit}
                onClick={() => {
                  setEditing(e);
                  setTab("ar");
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.common.delete}
                onClick={() => setDeleting(e)}
              >
                <Trash2 className="h-4 w-4 text-danger" />
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t.common.edit : t.docTemplates.addTemplate}
        wide
      >
        {editing && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.signerRoles.key} required hint={t.signerRoles.keyHint}>
                <Input
                  dir="ltr"
                  disabled={!!editing.id}
                  value={editing.key ?? ""}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
                    })
                  }
                />
              </Field>
              <Field label={t.docTemplates.category}>
                <Select
                  value={editing.category ?? "consent"}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                >
                  {Object.entries(t.docTemplates.categories).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t.docTemplates.name} required>
                <Input
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </Field>
              <Field label={t.docTemplates.nameAr}>
                <Input
                  dir="rtl"
                  value={editing.name_ar ?? ""}
                  onChange={(e) => setEditing({ ...editing, name_ar: e.target.value })}
                />
              </Field>
            </div>

            <Tabs
              tabs={[
                { key: "ar", label: t.common.arabic },
                { key: "en", label: t.common.english },
              ]}
              active={tab}
              onChange={(k) => setTab(k as "ar" | "en")}
            />
            <RichText
              key={tab}
              defaultValue={(tab === "ar" ? editing.body_ar : editing.body) ?? ""}
              dir={tab === "ar" ? "rtl" : "ltr"}
              minHeightClass="min-h-64"
              onChange={(html) =>
                setEditing((prev) =>
                  prev ? { ...prev, ...(tab === "ar" ? { body_ar: html } : { body: html }) } : prev
                )
              }
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.fields.moveUp}>
                <NumberInput
                  dir="ltr"
                  value={Number(editing.sort ?? 100)}
                  onChange={(v) => setEditing({ ...editing, sort: v })}
                />
              </Field>
              <label className="flex items-end justify-between gap-3 pb-1">
                <span className="text-[13px] font-medium">{t.docTemplates.active}</span>
                <Toggle
                  checked={editing.active !== false}
                  onChange={(v) => setEditing({ ...editing, active: v })}
                />
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                {t.common.cancel}
              </Button>
              <Button
                onClick={save}
                loading={pending}
                disabled={!editing.name?.trim() || !editing.key?.trim()}
              >
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t.docTemplates.deleteTemplate}
        body={t.docTemplates.deleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={() =>
          start(async () => {
            if (!deleting) return;
            await deleteLibraryTemplateAction(deleting.id);
            setDeleting(null);
            router.refresh();
          })
        }
      />
    </>
  );
}
