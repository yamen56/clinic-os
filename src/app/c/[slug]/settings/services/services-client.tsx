"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { fmtMoney } from "@/lib/dates";
import {
  saveServiceAction,
  toggleServiceAction,
  deleteServiceAction,
  saveSectionAction,
  deleteSectionAction,
  moveSectionAction,
} from "./actions";
import {
  Plus,
  Pencil,
  Trash2,
  Stethoscope,
  ChevronUp,
  ChevronDown,
  LayoutGrid,
} from "lucide-react";

type Service = {
  id: string;
  name: string;
  name_ar: string | null;
  duration_min: number;
  price: string;
  color: string;
  buffer_after_min: number;
  bookable_online: boolean;
  location_kind: "in_person" | "online";
  active: boolean;
  section_id: string | null;
  doctor_ids: string[];
};

type Section = {
  id: string;
  name: string;
  name_ar: string | null;
  color: string;
  service_count: number;
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
  locationKind: "in_person" | "online";
  sectionId: string | null;
  doctorIds: string[];
};

type SectionDraft = { id?: string; name: string; nameAr: string; color: string };

const empty: Draft = {
  name: "",
  nameAr: "",
  durationMin: 30,
  price: 0,
  color: "#0b1220",
  bufferAfterMin: 0,
  bookableOnline: true,
  locationKind: "in_person",
  sectionId: null,
  doctorIds: [],
};

const emptySection: SectionDraft = { name: "", nameAr: "", color: "#6989a6" };

export function ServicesClient({
  slug,
  canEdit,
  services,
  doctors,
  sections,
  currency,
}: {
  slug: string;
  canEdit: boolean;
  services: Service[];
  doctors: { id: string; name: string }[];
  sections: Section[];
  currency: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sectionDraft, setSectionDraft] = useState<SectionDraft | null>(null);
  const [deleteSectionId, setDeleteSectionId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const label = (x: { name: string; name_ar: string | null }) =>
    locale === "ar" ? x.name_ar || x.name : x.name;

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

  const saveSection = () =>
    start(async () => {
      if (!sectionDraft) return;
      const r = await saveSectionAction(slug, sectionDraft);
      if (r.error) {
        toast(r.error === "duplicate" ? t.sections.duplicate : t.common.genericError, "error");
        return;
      }
      toast(t.common.saved);
      setSectionDraft(null);
      router.refresh();
    });

  const moveSection = (id: string, direction: "up" | "down") =>
    start(async () => {
      await moveSectionAction(slug, id, direction);
      router.refresh();
    });

  /*
    The list as it reads on screen: each section with its services, then an
    unfiled group at the end — and only if something is actually in it. The
    services arrive already ordered, so this only has to cut them into runs.
  */
  const grouped = sections
    .map((sec) => ({ sec, items: services.filter((s) => s.section_id === sec.id) }))
    .concat([{ sec: null as unknown as Section, items: services.filter((s) => !s.section_id) }])
    .filter((g) => g.sec || g.items.length);

  const countLabel = (n: number) =>
    n === 0 ? t.sections.noServices : n === 1 ? t.sections.oneService : t.sections.serviceCount.replace("{n}", String(n));

  const serviceRow = (s: Service) => (
    <li
      key={s.id}
      className={`spine flex items-center gap-3 px-5 py-3 ${s.active ? "" : "opacity-50"}`}
      style={{ "--spine-color": s.color } as React.CSSProperties}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{label(s)}</span>
          {!s.active && <Badge status="cancelled">{t.services.inactive}</Badge>}
          {s.bookable_online && <Badge status="brand">{t.services.bookableOnline}</Badge>}
        </div>
        <div className="text-[13px] text-ink-500 tnum">
          {s.duration_min} {t.common.min} · {fmtMoney(Number(s.price), currency, locale)}
          {s.doctor_ids.length > 0 && ` · ${s.doctor_ids.length} ${t.calendar.doctor}`}
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
                locationKind: s.location_kind,
                sectionId: s.section_id,
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
  );

  return (
    <>
      <Card className="mb-5">
        <CardHeader
          title={t.sections.title}
          sub={t.sections.sub}
          action={
            canEdit && (
              <Button size="sm" variant="outline" onClick={() => setSectionDraft(emptySection)}>
                <Plus className="h-4 w-4" />
                {t.sections.addSection}
              </Button>
            )
          }
        />
        {sections.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<LayoutGrid />}
              title={t.sections.empty}
              body={t.sections.emptyBody}
              action={
                canEdit ? (
                  <Button onClick={() => setSectionDraft(emptySection)}>{t.sections.addSection}</Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {sections.map((sec, i) => (
              <li
                key={sec.id}
                className="spine flex items-center gap-3 px-5 py-3"
                style={{ "--spine-color": sec.color } as React.CSSProperties}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{label(sec)}</div>
                  <div className="text-[13px] text-ink-500 tnum">{countLabel(sec.service_count)}</div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-1.5">
                    <div className="flex flex-col">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t.sections.moveUp}
                        disabled={i === 0 || pending}
                        onClick={() => moveSection(sec.id, "up")}
                      >
                        <ChevronUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t.sections.moveDown}
                        disabled={i === sections.length - 1 || pending}
                        onClick={() => moveSection(sec.id, "down")}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t.common.edit}
                      onClick={() =>
                        setSectionDraft({
                          id: sec.id,
                          name: sec.name,
                          nameAr: sec.name_ar ?? "",
                          color: sec.color,
                        })
                      }
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t.common.delete}
                      onClick={() => setDeleteSectionId(sec.id)}
                    >
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>


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
        ) : sections.length === 0 ? (
          /* No sections: the list this screen has always shown, untouched. */
          <ul className="divide-y divide-line">{services.map(serviceRow)}</ul>
        ) : (
          <div className="divide-y divide-line">
            {grouped.map((g) => (
              <div key={g.sec?.id ?? "__unfiled"}>
                <div className="bg-sunken px-5 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-500">
                  {g.sec ? label(g.sec) : t.sections.unfiled}
                </div>
                {g.items.length === 0 ? (
                  <p className="px-5 py-3 text-[13px] text-ink-400">{t.sections.noServices}</p>
                ) : (
                  <ul className="divide-y divide-line">{g.items.map(serviceRow)}</ul>
                )}
              </div>
            ))}
          </div>
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
            {sections.length > 0 && (
              <Field label={t.services.section}>
                <Select
                  value={draft.sectionId ?? ""}
                  onChange={(e) => setDraft({ ...draft, sectionId: e.target.value || null })}
                >
                  <option value="">{t.sections.none}</option>
                  {sections.map((sec) => (
                    <option key={sec.id} value={sec.id}>
                      {label(sec)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {/* Same three-across squeeze as the booking link editor: the price
                label carries the currency in it, so it is the first to collide. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label={t.services.duration}>
                <NumberInput
                  dir="ltr" min={5} step={5}
                  value={draft.durationMin}
                  fallback={30}
                  onChange={(durationMin) => setDraft({ ...draft, durationMin })}
                />
              </Field>
              <Field label={`${t.services.price} (${currency})`}>
                <NumberInput
                  dir="ltr" min={0} step="0.5"
                  value={draft.price}
                  onChange={(price) => setDraft({ ...draft, price })}
                />
              </Field>
              <Field label={t.services.buffer}>
                <NumberInput
                  dir="ltr" min={0} step={5}
                  value={draft.bufferAfterMin}
                  onChange={(bufferAfterMin) => setDraft({ ...draft, bufferAfterMin })}
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
            <div className="grid grid-cols-1 gap-4">
              {/*
                Where it happens. An online meeting has no address to give, so the
                booking page shows the host's join link instead of the map and the
                phone number — see migration 0041.
              */}
              <Field label={t.services.locationKind}>
                <Select
                  value={draft.locationKind}
                  onChange={(e) =>
                    setDraft({ ...draft, locationKind: e.target.value as Draft["locationKind"] })
                  }
                >
                  <option value="in_person">{t.services.inPerson}</option>
                  <option value="online">{t.services.online}</option>
                </Select>
              </Field>
              {draft.locationKind === "online" && (
                <p className="text-[13px] text-ink-500">{t.services.onlineHint}</p>
              )}
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

      <Modal
        open={!!sectionDraft}
        onClose={() => setSectionDraft(null)}
        title={sectionDraft?.id ? t.common.edit : t.sections.addSection}
      >
        {sectionDraft && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.sections.name} required>
                <Input
                  value={sectionDraft.name}
                  onChange={(e) => setSectionDraft({ ...sectionDraft, name: e.target.value })}
                />
              </Field>
              <Field label={t.sections.nameAr}>
                <Input
                  dir="rtl"
                  value={sectionDraft.nameAr}
                  onChange={(e) => setSectionDraft({ ...sectionDraft, nameAr: e.target.value })}
                />
              </Field>
            </div>
            <Field label={t.sections.color}>
              <input
                type="color"
                value={sectionDraft.color}
                onChange={(e) => setSectionDraft({ ...sectionDraft, color: e.target.value })}
                className="h-9 w-14 cursor-pointer rounded-md border border-line-strong"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setSectionDraft(null)}>
                {t.common.cancel}
              </Button>
              <Button onClick={saveSection} loading={pending} disabled={!sectionDraft.name.trim()}>
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteSectionId}
        onClose={() => setDeleteSectionId(null)}
        title={t.common.confirmDeleteTitle}
        /* Says what happens to the services, because "delete" over a row that
           reads "6 services" looks like it takes them with it. It does not. */
        body={t.sections.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteSectionId) {
            await deleteSectionAction(slug, deleteSectionId);
            setDeleteSectionId(null);
            router.refresh();
          }
        }}
      />
    </>
  );
}
