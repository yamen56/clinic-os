"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { saveBookingLinkAction, deleteBookingLinkAction } from "./actions";
import { Plus, Pencil, Trash2, Copy, ExternalLink } from "lucide-react";

type LinkRow = {
  id: string;
  name: string;
  slug: string;
  doctor_member_id: string | null;
  service_ids: string[];
  min_notice_min: number;
  max_days_ahead: number;
  slot_granularity_min: number;
  approval_mode: "instant" | "approval";
  active: boolean;
};

export function BookingLinksClient({
  slug,
  canEdit,
  links,
  doctors,
  services,
}: {
  slug: string;
  canEdit: boolean;
  links: LinkRow[];
  doctors: { id: string; name: string }[];
  services: { id: string; name: string; name_ar: string | null }[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Partial<LinkRow> | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const save = () =>
    start(async () => {
      if (!editing) return;
      const r = await saveBookingLinkAction(slug, {
        id: editing.id,
        name: editing.name ?? "Default",
        slug: editing.slug ?? "",
        doctorMemberId: editing.doctor_member_id ?? null,
        serviceIds: editing.service_ids ?? [],
        minNoticeMin: editing.min_notice_min ?? 120,
        maxDaysAhead: editing.max_days_ahead ?? 30,
        slotGranularityMin: editing.slot_granularity_min ?? 30,
        approvalMode: editing.approval_mode ?? "instant",
        active: editing.active ?? true,
      });
      if (r.error) {
        toast(r.error === "slug_taken" ? `${t.admin.slug}!` : t.common.genericError, "error");
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
          title={t.bookingSettings.title}
          sub={t.bookingSettings.sub}
          action={
            canEdit && (
              <Button size="sm" onClick={() => setEditing({ min_notice_min: 120, max_days_ahead: 30, slot_granularity_min: 30, approval_mode: "instant", active: true, service_ids: [] })}>
                <Plus className="h-4 w-4" />
                {t.bookingSettings.addLink}
              </Button>
            )
          }
        />
        <ul className="divide-y divide-line">
          {links.map((l) => (
            <li key={l.id} className={`flex flex-wrap items-center gap-3 px-5 py-3 ${l.active ? "" : "opacity-50"}`}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{l.name}</span>
                  <Badge status={l.approval_mode === "instant" ? "confirmed" : "pending"}>
                    {l.approval_mode === "instant" ? t.bookingSettings.instant : t.bookingSettings.manual}
                  </Badge>
                  {!l.active && <Badge status="cancelled">{t.common.inactive}</Badge>}
                </div>
                <div className="mt-0.5 text-[13px] text-ink-500" dir="ltr">
                  /book/{l.slug}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(`${origin}/book/${l.slug}`);
                    toast(t.bookingSettings.copied);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t.common.copy}
                </Button>
                <a href={`/book/${l.slug}`} target="_blank" rel="noreferrer">
                  <Button variant="outline" size="sm">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t.bookingSettings.openPage}
                  </Button>
                </a>
                {canEdit && (
                  <>
                    <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setEditing(l)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {links.length > 1 && (
                      <Button variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => setDeleteId(l.id)}>
                        <Trash2 className="h-4 w-4 text-danger" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? t.common.edit : t.bookingSettings.addLink} wide>
        {editing && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.bookingSettings.linkName} required>
                <Input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label={t.bookingSettings.urlSlug} required>
                <Input
                  dir="ltr"
                  value={editing.slug ?? ""}
                  onChange={(e) =>
                    setEditing({ ...editing, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <Field label={t.bookingSettings.minNotice}>
                <Input type="number" dir="ltr" min={0} value={editing.min_notice_min ?? 120}
                  onChange={(e) => setEditing({ ...editing, min_notice_min: Number(e.target.value) || 0 })} />
              </Field>
              <Field label={t.bookingSettings.maxDays}>
                <Input type="number" dir="ltr" min={1} value={editing.max_days_ahead ?? 30}
                  onChange={(e) => setEditing({ ...editing, max_days_ahead: Number(e.target.value) || 30 })} />
              </Field>
              <Field label={t.bookingSettings.granularity}>
                <Input type="number" dir="ltr" min={5} step={5} value={editing.slot_granularity_min ?? 30}
                  onChange={(e) => setEditing({ ...editing, slot_granularity_min: Number(e.target.value) || 30 })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.bookingSettings.approval}>
                <Select
                  value={editing.approval_mode ?? "instant"}
                  onChange={(e) => setEditing({ ...editing, approval_mode: e.target.value as "instant" | "approval" })}
                >
                  <option value="instant">{t.bookingSettings.instant}</option>
                  <option value="approval">{t.bookingSettings.manual}</option>
                </Select>
              </Field>
              {doctors.length > 0 && (
                <Field label={t.bookingSettings.restrictDoctor}>
                  <Select
                    value={editing.doctor_member_id ?? ""}
                    onChange={(e) => setEditing({ ...editing, doctor_member_id: e.target.value || null })}
                  >
                    <option value="">{t.common.all}</option>
                    {doctors.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {services.length > 0 && (
              <Field label={t.bookingSettings.restrictServices} hint={t.common.optional}>
                <div className="flex flex-wrap gap-2">
                  {services.map((s) => {
                    const on = (editing.service_ids ?? []).includes(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() =>
                          setEditing({
                            ...editing,
                            service_ids: on
                              ? (editing.service_ids ?? []).filter((x) => x !== s.id)
                              : [...(editing.service_ids ?? []), s.id],
                          })
                        }
                        className={`rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                          on ? "border-brand-500 bg-brand-50 text-brand-800" : "border-line-strong text-ink-500"
                        }`}
                      >
                        {locale === "ar" ? s.name_ar || s.name : s.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            <label className="flex items-center gap-2.5">
              <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} />
              <span className="text-[13px] font-medium">{t.common.active}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>{t.common.cancel}</Button>
              <Button onClick={save} loading={pending} disabled={!editing.slug || !editing.name}>
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
            await deleteBookingLinkAction(slug, deleteId);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />
    </>
  );
}
