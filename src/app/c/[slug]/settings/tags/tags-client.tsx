"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { createTagAction, updateTagAction, deleteTagAction } from "./actions";
import { Tags as TagsIcon, Plus, Pencil, Trash2 } from "lucide-react";

type Tag = { id: string; name: string; color: string; used: number };

/** Colours worth offering: distinguishable at a glance on a crowded patient row. */
const SWATCHES = [
  "#6989a6", "#1e3a6b", "#5bc6e3", "#3f9e79",
  "#e4946b", "#c24a4a", "#8b6bb1", "#2a2d33",
];

export function TagsClient({ slug, tags }: { slug: string; tags: Tag[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<Partial<Tag> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Tag | null>(null);

  const save = () =>
    start(async () => {
      if (!editing) return;
      const name = (editing.name ?? "").trim();
      if (!name) return;
      const color = editing.color ?? SWATCHES[0];
      const r = editing.id
        ? await updateTagAction(slug, editing.id, { name, color })
        : await createTagAction(slug, name, color);
      if (r.error) {
        toast(r.error === "duplicate" ? t.tags.duplicate : t.common.genericError, "error");
        return;
      }
      toast(editing.id ? t.tags.saved : t.tags.created);
      setEditing(null);
      router.refresh();
    });

  return (
    <>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <TagsIcon className="h-4 w-4 text-ink-400" />
              {t.tags.title}
            </span>
          }
          sub={t.tags.sub}
          action={
            <Button size="sm" onClick={() => setEditing({ color: SWATCHES[0] })}>
              <Plus className="h-4 w-4" />
              {t.tags.addTag}
            </Button>
          }
        />

        {tags.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<TagsIcon />}
              title={t.tags.empty}
              body={t.tags.emptyBody}
              action={
                <Button onClick={() => setEditing({ color: SWATCHES[0] })}>{t.tags.addTag}</Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {tags.map((tag) => (
              <li key={tag.id} className="flex items-center gap-3 px-5 py-3">
                <span
                  className="inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
                  style={{ background: tag.color }}
                >
                  {tag.name}
                </span>
                <span className="min-w-0 flex-1 text-[12px] text-ink-500">
                  {tag.used > 0
                    ? t.tags.inUse.replace("{n}", String(tag.used))
                    : t.tags.unused}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.common.edit}
                  onClick={() => setEditing(tag)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.common.delete}
                  onClick={() => setConfirmDelete(tag)}
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? t.common.edit : t.tags.addTag}
      >
        {editing && (
          <div className="grid gap-4">
            <Field label={t.tags.tagName} hint={t.tags.tagNameHint} required>
              <Input
                autoFocus
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder="سكري"
              />
            </Field>

            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{t.tags.color}</span>
              <div className="flex flex-wrap gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    onClick={() => setEditing({ ...editing, color: c })}
                    style={{ background: c }}
                    className={`h-8 w-8 touch-manipulation rounded-full transition-transform duration-140 ease-out ${
                      editing.color === c
                        ? "ring-2 ring-ink-900 ring-offset-2"
                        : "hover:scale-110"
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* A preview, because a colour swatch and a filled pill read differently. */}
            <div className="rounded-lg bg-sunken p-3">
              <span
                className="inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
                style={{ background: editing.color ?? SWATCHES[0] }}
              >
                {(editing.name ?? "").trim() || t.tags.tagName}
              </span>
            </div>

            {editing.id && (editing as Tag).used > 0 && (
              <p className="text-[12px] text-ink-500">{t.tags.renameHint}</p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                {t.common.cancel}
              </Button>
              <Button loading={pending} disabled={!(editing.name ?? "").trim()} onClick={save}>
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title={t.tags.deleteTitle}
        body={
          confirmDelete && confirmDelete.used > 0
            ? `${t.tags.deleteBody} (${t.tags.inUse.replace("{n}", String(confirmDelete.used))})`
            : t.tags.deleteBody
        }
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={() =>
          start(async () => {
            if (!confirmDelete) return;
            const r = await deleteTagAction(slug, confirmDelete.id);
            if (r.error) toast(t.common.genericError, "error");
            else toast(t.tags.deleted);
            setConfirmDelete(null);
            router.refresh();
          })
        }
      />
    </>
  );
}
