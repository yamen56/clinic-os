"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { fmtMoney } from "@/lib/dates";
import { saveServiceAction, toggleServiceAction, deleteServiceAction } from "./actions";
import { Plus, Pencil, Trash2, Stethoscope } from "lucide-react";

type Service = {
  id: string;
  name: string;
  name_ar: string | null;
  duration_min: number;
  price: string;
  color: string;
  buffer_after_min: number;
  bookable_online: boolean;
  active: boolean;
  doctor_ids: string[];
};

type Draft = {
  id?: string;
  name: string;
  nameAr: string;
  durationMin: number;
  price: number;
  color: string;
  bufferAfterMin: number;
  bookableOnline: boolean;
  doctorIds: string[];
};

const empty: Draft = {
  name: "",
  nameAr: "",
  durationMin: 30,
  price: 0,
  color: "#6989a6",
  bufferAfterMin: 0,
  bookableOnline: true,
  doctorIds: [],
};

export function ServicesClient({
  slug,
  canEdit,
  services,
  doctors,
  currency,
}: {
  slug: string;
  canEdit: boolean;
  services: Service[];
  doctors: { id: string; name: string }[];
  currency: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      if (!draft) return;
      const r = await saveServiceAction(slug, draft);
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.common.saved);
      setDraft(null);
      router.refresh();
    });

  return (
    <>
      <Card>
        <CardHeader
          title={t.services.title}
          sub={t.services.sub}
          action={
            canEdit && (
              <Button size="sm" onClick={() => setDraft(empty)}>
                <Plus className="h-4 w-4" />
                {t.services.addService}
              </Button>
            )
          }
        />
        {services.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<Stethoscope />}
              title={t.services.empty}
              body={t.services.emptyBody}
              action={canEdit ? <Button onClick={() => setDraft(empty)}>{t.services.addService}</Button> : undefined}
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {services.map((s) => (
              <li
                key={s.id}
                className={`spine flex items-center gap-3 px-5 py-3 ${s.active ? "" : "opacity-50"}`}
                style={{ "--spine-color": s.color } as React.CSSProperties}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {locale === "ar" ? s.name_ar || s.name : s.name}
                    </span>
                    {!s.active && <Badge status="cancelled">{t.services.inactive}</Badge>}
                    {s.bookable_online && <Badge status="brand">{t.services.bookableOnline}</Badge>}
                  </div>
                  <div className="text-[13px] text-ink-500 tnum">
                    {s.duration_min} {t.common.min} · {fmtMoney(Number(s.price), currency, locale)}
                    {s.doctor_ids.length > 0 &&
                      ` · ${s.doctor_ids.length} ${t.calendar.doctor}`}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-1.5">
                    <Toggle
                      checked={s.active}
                      label={t.common.active}
                      onChange={async (v) => {
                        await toggleServiceAction(slug, s.id, v);
                        router.refresh();
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t.common.edit}
                      onClick={() =>
                        setDraft({
                          id: s.id,
                          name: s.name,
                          nameAr: s.name_ar ?? "",
                          durationMin: s.duration_min,
                          price: Number(s.price),
                          color: s.color,
                          bufferAfterMin: s.buffer_after_min,
                          bookableOnline: s.bookable_online,
                          doctorIds: s.doctor_ids,
                        })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteId(s.id)}>
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? t.common.edit : t.services.addService}
      >
        {draft && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.services.name} required>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label={t.services.nameAr}>
                <Input dir="rtl" value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Field label={t.services.duration}>
                <Input
                  type="number" dir="ltr" min={5} step={5}
                  value={draft.durationMin}
                  onChange={(e) => setDraft({ ...draft, durationMin: Number(e.target.value) || 30 })}
                />
              </Field>
              <Field label={`${t.services.price} (${currency})`}>
                <Input
                  type="number" dir="ltr" min={0} step="0.5"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label={t.services.buffer}>
                <Input
                  type="number" dir="ltr" min={0} step={5}
                  value={draft.bufferAfterMin}
                  onChange={(e) => setDraft({ ...draft, bufferAfterMin: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>
            <div className="flex items-center gap-6">
              <Field label={t.services.color}>
                <input
                  type="color"
                  value={draft.color}
                  onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                  className="h-9 w-14 cursor-pointer rounded-md border border-line-strong"
                />
              </Field>
              <label className="flex items-center gap-2.5 pt-5">
                <Toggle checked={draft.bookableOnline} onChange={(v) => setDraft({ ...draft, bookableOnline: v })} />
                <span className="text-[13px] font-medium">{t.services.bookableOnline}</span>
              </label>
            </div>
            {doctors.length > 0 && (
              <Field label={t.services.doctors}>
                <div className="flex flex-wrap gap-2">
                  {doctors.map((d) => {
                    const on = draft.doctorIds.includes(d.id);
                    return (
                      <button
                        key={d.id}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            doctorIds: on
                              ? draft.doctorIds.filter((x) => x !== d.id)
                              : [...draft.doctorIds, d.id],
                          })
                        }
                        className={`rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                          on
                            ? "border-brand-500 bg-brand-50 text-brand-800"
                            : "border-line-strong text-ink-500 hover:bg-sunken"
                        }`}
                      >
                        {d.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDraft(null)}>
                {t.common.cancel}
              </Button>
              <Button onClick={save} loading={pending} disabled={!draft.name.trim()}>
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
            await deleteServiceAction(slug, deleteId);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />
    </>
  );
}
