"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { saveInsurerAction, deleteInsurerAction } from "./actions";
import { ShieldCheck, Plus, Trash2 } from "lucide-react";

type Insurer = {
  id: string;
  name: string;
  code: string;
  notes: string;
  active: boolean;
  patients: number;
  open_claims: number;
};

export function InsurersClient({ slug, initial }: { slug: string; initial: Insurer[] }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Insurer | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [pending, start] = useTransition();

  const openNew = () => {
    setEditing(null);
    setName("");
    setCode("");
    setOpen(true);
  };
  const openEdit = (i: Insurer) => {
    setEditing(i);
    setName(i.name);
    setCode(i.code);
    setOpen(true);
  };

  return (
    <>
      <Card>
        <CardHeader
          title={t.insurers.title}
          sub={t.insurers.sub}
          action={
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4" />
              {t.insurers.add}
            </Button>
          }
        />
        {initial.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<ShieldCheck />}
              title={t.insurers.emptyTitle}
              body={t.insurers.emptyBody}
              action={
                <Button onClick={openNew}>
                  <Plus className="h-4 w-4" />
                  {t.insurers.add}
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {initial.map((i) => (
              <li
                key={i.id}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5 ${
                  i.active ? "" : "opacity-60"
                }`}
              >
                <button
                  className="min-w-0 flex-1 text-start hover:underline"
                  onClick={() => openEdit(i)}
                >
                  <span className="block truncate text-sm font-semibold">{i.name}</span>
                  {i.code && (
                    <span className="block truncate text-[13px] text-ink-500" dir="ltr">
                      {i.code}
                    </span>
                  )}
                </button>
                {i.open_claims > 0 && (
                  <Badge status="pending">
                    {i.open_claims} {t.insurers.openClaims}
                  </Badge>
                )}
                <span className="text-[13px] text-ink-400">
                  {i.patients} {t.insurers.patients}
                </span>
                {!i.active && <Badge status="neutral">{t.insurers.inactive}</Badge>}
                <button
                  aria-label={t.common.delete}
                  className="text-ink-300 hover:text-danger"
                  onClick={() =>
                    start(async () => {
                      await deleteInsurerAction(slug, i.id);
                      router.refresh();
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t.insurers.edit : t.insurers.add}
      >
        <div className="grid gap-4">
          <Field label={t.insurers.name} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          {/* The string reception types into the insurer's own portal, which is
              almost never the same as the display name. */}
          <Field label={t.insurers.code} hint={t.insurers.codeHint}>
            <Input value={code} dir="ltr" onChange={(e) => setCode(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              loading={pending}
              disabled={!name.trim()}
              onClick={() =>
                start(async () => {
                  const r = await saveInsurerAction(slug, {
                    id: editing?.id,
                    name,
                    code,
                    active: true,
                  });
                  if (r.error) return toast(t.common.required, "error");
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {t.common.save}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
