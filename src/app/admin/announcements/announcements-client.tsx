"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea, Toggle } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  createAnnouncementAction,
  toggleAnnouncementAction,
  deleteAnnouncementAction,
} from "./actions";
import { Megaphone, Trash2, Plus } from "lucide-react";

type Announcement = {
  id: string;
  title: string;
  body: string;
  active: boolean;
  created_at: string;
  author: string | null;
};

export function AnnouncementsClient({ announcements }: { announcements: Announcement[] }) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="grid gap-4">
      <Card className="p-5">
        <div className="grid gap-4">
          <Field label="Title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scheduled maintenance Friday 10pm" />
          </Field>
          <Field label="Message">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-20" />
          </Field>
          <div className="flex justify-end">
            <Button
              disabled={!title.trim()}
              loading={pending}
              onClick={() =>
                start(async () => {
                  const r = await createAnnouncementAction({ title, body });
                  if (r?.error) {
                    toast(t.common.genericError, "error");
                    return;
                  }
                  toast(t.common.saved);
                  setTitle("");
                  setBody("");
                  router.refresh();
                })
              }
            >
              <Plus className="h-4 w-4" />
              {t.common.create}
            </Button>
          </div>
        </div>
      </Card>

      {announcements.length === 0 ? (
        <EmptyState icon={<Megaphone />} title="No announcements" body="Anything you post here appears at the top of every clinic dashboard." />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {announcements.map((a) => (
              <li key={a.id} className={`flex items-start gap-3 px-5 py-3.5 ${a.active ? "" : "opacity-60"}`}>
                <Toggle
                  checked={a.active}
                  label="Active"
                  onChange={async (v) => {
                    await toggleAnnouncementAction(a.id, v);
                    router.refresh();
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{a.title}</div>
                  {a.body && <p className="mt-0.5 text-[13px] text-ink-500">{a.body}</p>}
                  <div className="mt-0.5 text-[12px] text-ink-400">{a.author ?? ""}</div>
                </div>
                <button
                  aria-label={t.common.delete}
                  onClick={() => setDeleteId(a.id)}
                  className="text-ink-300 transition-colors hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t.common.confirmDeleteTitle}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteId) {
            await deleteAnnouncementAction(deleteId);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}
