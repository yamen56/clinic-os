"use client";

import { useMemo, useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ServiceChips } from "@/components/ui/service-picker";
import { serviceLabel, type SectionRow, type ServiceRow } from "@/lib/services";
import { saveRoomAction, moveRoomAction, removeRoomAction, setDoctorRoomAction, placeUpcomingAction } from "./actions";
import { DoorOpen, Plus, Pencil, Trash2, ChevronUp, ChevronDown, AlertTriangle, Stethoscope } from "lucide-react";

type Room = { id: string; name: string; name_ar: string | null; color: string; service_ids: string[] };
type Doctor = { id: string; name: string; color: string | null; default_room_id: string | null };

/** Distinct at a glance on a crowded board, and readable with white text. */
const SWATCHES = ["#4a6b8a", "#2b7fb8", "#3f9e79", "#7056a8", "#c2593a", "#b0487a", "#8a6d3b", "#2a2d33"];

export function RoomsClient({
  slug,
  rooms,
  doctors,
  services,
  sections,
  inPerson,
  unroomed,
}: {
  slug: string;
  rooms: Room[];
  doctors: Doctor[];
  services: ServiceRow[];
  sections: SectionRow[];
  /** In-person services — the ones a room matters for. */
  inPerson: string[];
  unroomed: number;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<Partial<Room> | null>(null);
  const [removing, setRemoving] = useState<Room | null>(null);
  /* The doctor selects answer the click, not the server. */
  const [doctorRoom, setDoctorRoom] = useState<Record<string, string>>(() =>
    Object.fromEntries(doctors.map((d) => [d.id, d.default_room_id ?? ""]))
  );

  const label = (r: { name: string; name_ar: string | null }) => (locale === "ar" && r.name_ar) || r.name;

  /* Services no room can host book without one — say which, by name. */
  const unhosted = useMemo(() => {
    if (!rooms.length || rooms.some((r) => r.service_ids.length === 0)) return [];
    const hosted = new Set(rooms.flatMap((r) => r.service_ids));
    return services.filter((s) => inPerson.includes(s.id) && !hosted.has(s.id));
  }, [rooms, services, inPerson]);

  const save = () =>
    start(async () => {
      if (!editing) return;
      const name = (editing.name ?? "").trim();
      if (!name) return;
      const r = await saveRoomAction(slug, {
        id: editing.id,
        name,
        nameAr: editing.name_ar ?? null,
        color: editing.color ?? SWATCHES[0],
        serviceIds: editing.service_ids ?? [],
      });
      if (r.error) {
        toast(r.error === "duplicate" ? t.rooms.duplicate : t.common.genericError, "error");
        return;
      }
      toast(editing.id ? t.rooms.saved : t.rooms.created);
      setEditing(null);
    });

  const servicesSummary = (r: Room) => {
    if (!r.service_ids.length) return t.rooms.anyService;
    const names = services.filter((s) => r.service_ids.includes(s.id)).map((s) => serviceLabel(s, locale));
    return names.length <= 3 ? names.join(" · ") : `${names.slice(0, 3).join(" · ")} +${names.length - 3}`;
  };

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <DoorOpen className="h-4 w-4 text-ink-400" />
              {t.rooms.title}
            </span>
          }
          sub={t.rooms.sub}
          action={
            <Button size="sm" onClick={() => setEditing({ color: SWATCHES[rooms.length % SWATCHES.length], service_ids: [] })}>
              <Plus className="h-4 w-4" />
              {t.rooms.add}
            </Button>
          }
        />

        {rooms.length === 0 ? (
          <div className="p-5">
            <EmptyState
              bare
              icon={<DoorOpen />}
              title={t.rooms.empty}
              body={t.rooms.emptyBody}
              action={
                <Button onClick={() => setEditing({ color: SWATCHES[0], service_ids: [] })}>
                  <Plus className="h-4 w-4" />
                  {t.rooms.add}
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line" data-rooms-list>
            {rooms.map((room, i) => (
              <li key={room.id} className="flex items-center gap-3 px-4 py-3 sm:px-5" data-room={room.name}>
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white"
                  style={{ background: room.color }}
                >
                  <DoorOpen className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  {/* One line that truncates as a whole; the Arabic name is
                      isolated so it keeps its own direction inside it. */}
                  <div className="truncate text-sm font-semibold text-ink-900">
                    {label(room)}
                    {room.name_ar && locale !== "ar" ? ` · ⁨${room.name_ar}⁩` : ""}
                  </div>
                  <div className="truncate text-[12px] text-ink-500">{servicesSummary(room)}</div>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.rooms.moveUp}
                    disabled={i === 0 || pending}
                    onClick={() => start(async () => void (await moveRoomAction(slug, room.id, -1)))}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.rooms.moveDown}
                    disabled={i === rooms.length - 1 || pending}
                    onClick={() => start(async () => void (await moveRoomAction(slug, room.id, 1)))}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setEditing(room)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t.rooms.remove} onClick={() => setRemoving(room)}>
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {unhosted.length > 0 && (
          <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg bg-st-pending-soft px-3 py-2.5 text-[13px] text-ink-700 sm:mx-5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-st-pending" />
            <span>{t.rooms.unhosted.replace("{list}", unhosted.map((s) => serviceLabel(s, locale)).join("، "))}</span>
          </div>
        )}
      </Card>

      {rooms.length > 0 && unroomed > 0 && (
        <Card className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-[13px] text-ink-700">
              {t.rooms.placeSub.replace("{n}", String(unroomed))}
            </p>
            <Button
              loading={pending}
              onClick={() =>
                start(async () => {
                  const r = await placeUpcomingAction(slug);
                  if (r.error) return toast(t.common.genericError, "error");
                  toast(t.rooms.placed.replace("{n}", String(r.placed ?? 0)));
                  if (r.notPlaced) toast(t.rooms.notPlaced.replace("{n}", String(r.notPlaced)), "error");
                })
              }
            >
              {t.rooms.place}
            </Button>
          </div>
        </Card>
      )}

      {rooms.length > 0 && doctors.length > 0 && (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Stethoscope className="h-4 w-4 text-ink-400" />
                {t.rooms.doctorRooms}
              </span>
            }
            sub={t.rooms.doctorRoomsSub}
          />
          <ul className="divide-y divide-line">
            {doctors.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color ?? "var(--color-ink-300)" }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
                <Select
                  value={doctorRoom[d.id] ?? ""}
                  className="!w-44 max-w-[50vw]"
                  aria-label={`${t.rooms.doctorRooms}: ${d.name}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    const prev = doctorRoom[d.id] ?? "";
                    setDoctorRoom((m) => ({ ...m, [d.id]: v }));
                    start(async () => {
                      const r = await setDoctorRoomAction(slug, d.id, v || null);
                      if (r.error) {
                        setDoctorRoom((m) => ({ ...m, [d.id]: prev }));
                        toast(t.common.genericError, "error");
                      }
                    });
                  }}
                >
                  <option value="">{t.rooms.noDefault}</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {label(r)}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? t.common.edit : t.rooms.add}>
        {editing && (
          <div className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.rooms.name} required>
                <Input
                  autoFocus
                  value={editing.name ?? ""}
                  placeholder={t.rooms.namePlaceholder}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                />
              </Field>
              <Field label={t.rooms.nameAr}>
                <Input
                  dir="rtl"
                  value={editing.name_ar ?? ""}
                  placeholder="غرفة 1"
                  onChange={(e) => setEditing({ ...editing, name_ar: e.target.value })}
                />
              </Field>
            </div>

            <div>
              <span className="mb-1.5 block text-[13px] font-medium text-ink-700">{t.rooms.color}</span>
              <div className="flex flex-wrap gap-2">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    onClick={() => setEditing({ ...editing, color: c })}
                    style={{ background: c }}
                    className={`h-8 w-8 touch-manipulation rounded-full transition-transform duration-140 ease-out ${
                      editing.color === c ? "ring-2 ring-ink-900 ring-offset-2" : "hover:scale-110"
                    }`}
                  />
                ))}
              </div>
            </div>

            {services.length > 0 && (
              <div>
                <span className="mb-0.5 block text-[13px] font-medium text-ink-700">{t.rooms.services}</span>
                <span className="mb-2 block text-[12px] text-ink-500">{t.rooms.servicesHint}</span>
                <ServiceChips
                  services={services}
                  sections={sections}
                  selected={editing.service_ids ?? []}
                  onToggle={(id) => {
                    const cur = editing.service_ids ?? [];
                    setEditing({ ...editing, service_ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
                  }}
                />
              </div>
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
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t.rooms.remove}
        body={t.rooms.removeBody}
        confirmLabel={t.rooms.remove}
        cancelLabel={t.common.cancel}
        onConfirm={() =>
          start(async () => {
            if (!removing) return;
            const r = await removeRoomAction(slug, removing.id);
            if (r.error) toast(t.common.genericError, "error");
            else toast(t.rooms.removed);
            setRemoving(null);
          })
        }
      />
    </div>
  );
}
