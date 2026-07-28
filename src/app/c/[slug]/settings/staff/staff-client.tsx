"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { WeeklyHoursEditor } from "@/components/weekly-hours-editor";
import { addStaffAction, updateMemberAction, resendInviteAction } from "./actions";
import { UserPlus, Pencil } from "lucide-react";

type Member = {
  id: string;
  role: "owner" | "doctor" | "receptionist";
  title: string | null;
  specialty: string | null;
  color: string;
  active: boolean;
  reminder_minutes: number;
  permissions: Record<string, boolean>;
  working_hours: Record<string, [string, string][]> | null;
  full_name: string;
  email: string;
};

export function StaffClient({
  slug,
  members,
  selfId,
}: {
  slug: string;
  members: Member[];
  selfId: string | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    role: "receptionist",
    title: "",
    specialty: "",
    color: "#6989a6",
  });
  const [pending, start] = useTransition();

  const roleLabel = (r: string) =>
    r === "owner" ? t.staff.roleOwner : r === "doctor" ? t.staff.roleDoctor : t.staff.roleReceptionist;

  return (
    <>
      <Card>
        <CardHeader
          title={t.staff.title}
          sub={t.staff.sub}
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <UserPlus className="h-4 w-4" />
              {t.staff.addStaff}
            </Button>
          }
        />
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <li key={m.id} className={`flex items-center gap-3 px-5 py-3 ${m.active ? "" : "opacity-50"}`}>
              <Avatar name={m.full_name} size={36} color={m.color} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{m.full_name}</span>
                  <Badge status={m.role === "owner" ? "brand" : m.role === "doctor" ? "confirmed" : "neutral"}>
                    {roleLabel(m.role)}
                  </Badge>
                  {!m.active && <Badge status="cancelled">{t.common.inactive}</Badge>}
                </div>
                <div className="truncate text-[13px] text-ink-500" dir="ltr">
                  {m.email}
                  {m.specialty ? ` · ${m.specialty}` : ""}
                </div>
              </div>
              <Button variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => setEditing(m)}>
                <Pencil className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      {/* Add staff */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t.staff.addStaff}>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.staff.fullName} required>
              <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </Field>
            <Field label={t.common.email} required>
              <Input dir="ltr" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <p className="rounded-ctl bg-sunken px-3 py-2 text-[13px] text-ink-700">
              {t.staff.inviteExplainer}
            </p>
            <Field label={t.common.status}>
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="receptionist">{t.staff.roleReceptionist}</option>
                <option value="doctor">{t.staff.roleDoctor}</option>
                <option value="owner">{t.staff.roleOwner}</option>
              </Select>
            </Field>
          </div>
          {form.role === "doctor" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.staff.title2}>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="د." />
              </Field>
              <Field label={t.staff.specialty}>
                <Input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
              </Field>
            </div>
          )}
          <Field label={t.staff.color}>
            <input
              type="color"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
              className="h-9 w-14 cursor-pointer rounded-md border border-line-strong"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              loading={pending}
              disabled={!form.fullName || !form.email}
              onClick={() =>
                start(async () => {
                  const r = await addStaffAction(slug, form);
                  if (r.error) {
                    toast(t.common.genericError, "error");
                    return;
                  }
                  if (r.inviteUrl) {
                    // Email could not be delivered — hand the owner the link.
                    setInviteLink(r.inviteUrl);
                  } else {
                    toast(
                      r.existing ? t.staff.emailTaken : t.staff.invited,
                      r.existing ? "info" : "success"
                    );
                  }
                  setAddOpen(false);
                  setForm({ fullName: "", email: "", role: "receptionist", title: "", specialty: "", color: "#6989a6" });
                  router.refresh();
                })
              }
            >
              {t.common.add}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Shown only when the invitation email could not be delivered. */}
      <Modal
        open={!!inviteLink}
        onClose={() => setInviteLink(null)}
        title={t.staff.inviteLinkTitle}
      >
        <p className="text-sm text-ink-700">{t.staff.inviteLinkBody}</p>
        <p className="mt-3 break-all rounded-ctl bg-sunken px-3 py-2 font-mono text-[12px] text-ink-900">
          {inviteLink}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink ?? "");
              toast(t.common.copied);
            }}
          >
            {t.common.copy}
          </Button>
          <Button onClick={() => setInviteLink(null)}>{t.common.done}</Button>
        </div>
      </Modal>

      {/* Edit member */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.full_name} wide>
        {editing && <EditMember key={editing.id} slug={slug} member={editing} isSelf={editing.id === selfId} onDone={() => { setEditing(null); router.refresh(); }} />}
      </Modal>
    </>
  );
}

function EditMember({
  slug,
  member,
  isSelf,
  onDone,
}: {
  slug: string;
  member: Member;
  isSelf: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [m, setM] = useState(member);
  const [ownHours, setOwnHours] = useState(!!member.working_hours);
  const [pending, start] = useTransition();

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.common.status}>
          <Select value={m.role} disabled={isSelf} onChange={(e) => setM({ ...m, role: e.target.value as Member["role"] })}>
            <option value="receptionist">{t.staff.roleReceptionist}</option>
            <option value="doctor">{t.staff.roleDoctor}</option>
            <option value="owner">{t.staff.roleOwner}</option>
          </Select>
        </Field>
        <Field label={t.staff.title2}>
          <Input value={m.title ?? ""} onChange={(e) => setM({ ...m, title: e.target.value })} />
        </Field>
        <Field label={t.staff.specialty}>
          <Input value={m.specialty ?? ""} onChange={(e) => setM({ ...m, specialty: e.target.value })} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.staff.color}>
          <input
            type="color"
            value={m.color}
            onChange={(e) => setM({ ...m, color: e.target.value })}
            className="h-9 w-14 cursor-pointer rounded-md border border-line-strong"
          />
        </Field>
        {m.role === "doctor" && (
          <Field label={t.staff.reminderMinutes}>
            <Input
              type="number"
              dir="ltr"
              min={0}
              max={1440}
              value={m.reminder_minutes}
              onChange={(e) => setM({ ...m, reminder_minutes: Number(e.target.value) || 0 })}
            />
          </Field>
        )}
        {m.role === "receptionist" && (
          <label className="flex items-center gap-2.5 self-end pb-2">
            <Toggle
              checked={m.permissions?.automations === true}
              onChange={(v) => setM({ ...m, permissions: { ...m.permissions, automations: v } })}
            />
            <span className="text-[13px] font-medium">{t.staff.canAutomations}</span>
          </label>
        )}
      </div>

      {m.role === "doctor" && (
        <div className="rounded-lg border border-line p-3">
          <label className="mb-2 flex items-center gap-2.5">
            <Toggle
              checked={ownHours}
              onChange={(v) => {
                setOwnHours(v);
                if (!v) setM({ ...m, working_hours: null });
                else if (!m.working_hours)
                  setM({ ...m, working_hours: { sun: [["09:00", "17:00"]], mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [], sat: [] } });
              }}
            />
            <span className="text-[13px] font-medium">
              {ownHours ? t.staff.ownHours : t.staff.useClinicHours}
            </span>
          </label>
          {ownHours && m.working_hours && (
            <WeeklyHoursEditor value={m.working_hours} onChange={(v) => setM({ ...m, working_hours: v })} />
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        {!isSelf ? (
          <Button
            variant={m.active ? "danger" : "outline"}
            onClick={() =>
              start(async () => {
                await updateMemberAction(slug, m.id, { active: !m.active });
                onDone();
              })
            }
          >
            {m.active ? t.staff.deactivate : t.staff.reactivate}
          </Button>
        ) : (
          <span />
        )}
        <Button
          loading={pending}
          onClick={() =>
            start(async () => {
              const r = await updateMemberAction(slug, m.id, {
                role: m.role,
                title: m.title ?? "",
                specialty: m.specialty ?? "",
                color: m.color,
                reminderMinutes: m.reminder_minutes,
                permissions: m.permissions ?? {},
                workingHours: ownHours ? m.working_hours : null,
              });
              if (r.error) {
                toast(t.common.genericError, "error");
                return;
              }
              toast(t.common.saved);
              onDone();
            })
          }
        >
          {t.common.save}
        </Button>
      </div>
    </div>
  );
}
