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
import { PhotoPicker } from "@/components/photo-picker";
import { addStaffAction, updateMemberAction } from "./actions";
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  ROLE_DEFAULTS,
  accessLevelOf,
  allCapabilities,
  capabilitiesFor,
  resolveCapabilities,
  type Capability,
  type CapabilityMap,
  type MemberRole,
} from "@/lib/permissions";
import { UserPlus, Pencil, Lock } from "lucide-react";

type Member = {
  id: string;
  role: MemberRole;
  is_owner: boolean;
  title: string | null;
  specialty: string | null;
  color: string;
  active: boolean;
  reminder_minutes: number;
  permissions: Record<string, unknown>;
  working_hours: Record<string, [string, string][]> | null;
  full_name: string;
  email: string;
  has_photo: boolean;
};

const ROLES: MemberRole[] = ["doctor", "receptionist", "other"];

export function StaffClient({
  slug,
  members,
  selfId,
  viewerIsOwner,
}: {
  slug: string;
  members: Member[];
  selfId: string | null;
  viewerIsOwner: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [form, setForm] = useState<{
    fullName: string;
    email: string;
    role: MemberRole;
    access: "full" | "custom";
    caps: CapabilityMap;
    title: string;
    specialty: string;
    color: string;
  }>({
    fullName: "",
    email: "",
    role: "receptionist",
    access: "custom",
    caps: capabilitiesFor(ROLE_DEFAULTS.receptionist),
    title: "",
    specialty: "",
    color: "#0b1220",
  });
  const [pending, start] = useTransition();

  const resetForm = () =>
    setForm({
      fullName: "",
      email: "",
      role: "receptionist",
      access: "custom",
      caps: capabilitiesFor(ROLE_DEFAULTS.receptionist),
      title: "",
      specialty: "",
      color: "#0b1220",
    });

  /** Summary line for the list: "Full access" or how many of the sections. */
  const accessSummary = (m: Member) => {
    if (m.is_owner) return t.staff.fullAccess;
    const level = accessLevelOf(m.permissions);
    if (level === "full") return t.staff.fullAccess;
    const caps = resolveCapabilities(m.permissions, { isOwner: false, role: m.role });
    const on = CAPABILITY_GROUPS.filter((g) => caps[g.section]).length;
    return t.staff.partialAccess.replace("{n}", String(on)).replace("{total}", String(CAPABILITY_GROUPS.length));
  };

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
              <Avatar
                name={m.full_name}
                size={36}
                color={m.color}
                src={m.has_photo ? `/api/c/${slug}/staff/${m.id}/photo` : null}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{m.full_name}</span>
                  <Badge status={m.role === "doctor" ? "confirmed" : "neutral"}>
                    {t.staff.roles[m.role]}
                  </Badge>
                  {/*
                    Ownership is shown but never offered as a job. It is not one:
                    the owner is also a doctor or a receptionist, and this badge
                    only explains why their access cannot be edited here.
                  */}
                  {m.is_owner && (
                    <Badge status="brand">
                      <Lock className="h-3 w-3" />
                      {t.staff.owner}
                    </Badge>
                  )}
                  {!m.active && <Badge status="cancelled">{t.common.inactive}</Badge>}
                </div>
                <div className="truncate text-[13px] text-ink-500" dir="ltr">
                  {m.email}
                  {m.specialty ? ` · ${m.specialty}` : ""}
                </div>
                <div className="text-[12px] text-ink-400">{accessSummary(m)}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.common.edit}
                disabled={m.is_owner && !viewerIsOwner}
                onClick={() => setEditing(m)}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      {/* Add staff */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t.staff.addStaff} wide>
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
            <Field label={t.staff.role} hint={t.staff.roleHint}>
              <Select
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value as MemberRole;
                  // The job reselects the suggested access. It overwrites any
                  // ticking done so far, which is the right trade on an invite
                  // form: picking "doctor" after "receptionist" means the whole
                  // starting point was wrong, not just the label.
                  setForm({ ...form, role, caps: capabilitiesFor(ROLE_DEFAULTS[role]) });
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t.staff.roles[r]}
                  </option>
                ))}
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

          <AccessEditor
            level={form.access}
            caps={form.caps}
            onLevel={(access) => setForm({ ...form, access })}
            onCaps={(caps) => setForm({ ...form, caps })}
          />

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              loading={pending}
              disabled={!form.fullName || !form.email}
              onClick={() =>
                start(async () => {
                  const r = await addStaffAction(slug, {
                    fullName: form.fullName,
                    email: form.email,
                    role: form.role,
                    access: form.access,
                    caps: CAPABILITIES.filter((c) => form.caps[c]),
                    title: form.title,
                    specialty: form.specialty,
                    color: form.color,
                  });
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
                  resetForm();
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
        {editing && (
          <EditMember
            key={editing.id}
            slug={slug}
            member={editing}
            isSelf={editing.id === selfId}
            onDone={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        )}
      </Modal>
    </>
  );
}

/**
 * Full or custom, and when custom, exactly what.
 *
 * "Full" is not a shorthand for ticking every box — it is stored as a level, so
 * a member on full access picks up capabilities that ship after today without
 * anybody revisiting this screen. Ticking everything by hand would not do that,
 * which is why the two are genuinely different settings and not two ways to say
 * the same thing.
 */
function AccessEditor({
  level,
  caps,
  onLevel,
  onCaps,
}: {
  level: "full" | "custom";
  caps: CapabilityMap;
  onLevel: (level: "full" | "custom") => void;
  onCaps: (caps: CapabilityMap) => void;
}) {
  const { t } = useI18n();

  const setCap = (cap: Capability, on: boolean) => {
    const next = { ...caps, [cap]: on };
    // Turning a section off takes its actions with it — the reverse would leave
    // someone able to void a document they cannot open.
    if (!on) {
      for (const g of CAPABILITY_GROUPS) {
        if (g.section === cap) for (const a of g.actions) next[a] = false;
      }
    }
    onCaps(next);
  };

  return (
    <div className="rounded-lg border border-line">
      <div className="border-b border-line px-4 py-3">
        <span className="block text-[13px] font-semibold">{t.staff.accessTitle}</span>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-500">{t.staff.accessSub}</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {(["full", "custom"] as const).map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => {
                onLevel(lv);
                // Switching to custom starts from everything, so the owner
                // removes what they mean to remove rather than rebuilding the
                // whole set from an empty list.
                if (lv === "custom" && level === "full") onCaps(allCapabilities());
              }}
              className={`touch-manipulation rounded-ctl border px-3 py-1.5 text-[13px] font-medium transition-colors duration-140 ease-out ${
                level === lv
                  ? "border-brand-600 bg-brand-50 text-brand-800"
                  : "border-line text-ink-700 hover:border-line-strong"
              }`}
            >
              {lv === "full" ? t.staff.fullAccess : t.staff.partialAccessLabel}
            </button>
          ))}
        </div>
      </div>

      {level === "custom" ? (
        <ul className="grid gap-0.5 p-2">
          {CAPABILITY_GROUPS.map((g) => (
            <li key={g.section}>
              <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-sunken">
                <span className="text-[13px] font-medium">{t.caps[g.section]}</span>
                <Toggle
                  checked={caps[g.section]}
                  label={t.caps[g.section]}
                  onChange={(v) => setCap(g.section, v)}
                />
              </label>
              {g.actions.length > 0 && caps[g.section] && (
                <ul className="mb-1 ms-3 border-s border-line ps-3">
                  {g.actions.map((a) => (
                    <li key={a}>
                      <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 hover:bg-sunken">
                        <span className="text-[12px] text-ink-700">{t.caps[a]}</span>
                        <Toggle checked={caps[a]} label={t.caps[a]} onChange={(v) => setCap(a, v)} />
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-[12px] leading-relaxed text-ink-500">{t.staff.fullAccessHint}</p>
      )}
    </div>
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
  const [level, setLevel] = useState<"full" | "custom">(
    member.is_owner ? "full" : accessLevelOf(member.permissions)
  );
  const [caps, setCaps] = useState<CapabilityMap>(
    resolveCapabilities(member.permissions, { isOwner: member.is_owner, role: member.role })
  );
  const [ownHours, setOwnHours] = useState(!!member.working_hours);
  const [pending, start] = useTransition();

  // The owner's access is not editable and neither is your own — the server
  // refuses both, and a form that lets you set something it will reject is
  // worse than one that says why.
  const accessLocked = member.is_owner || isSelf;

  return (
    <div className="grid gap-4">
      <PhotoPicker
        slug={slug}
        memberId={member.id}
        name={member.full_name}
        hasPhoto={member.has_photo}
        color={m.color}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.staff.role}>
          <Select
            value={m.role}
            disabled={isSelf}
            onChange={(e) => setM({ ...m, role: e.target.value as MemberRole })}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t.staff.roles[r]}
              </option>
            ))}
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
      </div>

      {accessLocked ? (
        <p className="rounded-lg border border-line bg-sunken px-4 py-3 text-[12px] leading-relaxed text-ink-500">
          {member.is_owner ? t.staff.ownerAccessLocked : t.staff.selfAccessLocked}
        </p>
      ) : (
        <AccessEditor level={level} caps={caps} onLevel={setLevel} onCaps={setCaps} />
      )}

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
        {!isSelf && !member.is_owner ? (
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
                role: isSelf ? undefined : m.role,
                title: m.title ?? "",
                specialty: m.specialty ?? "",
                color: m.color,
                reminderMinutes: m.reminder_minutes,
                access: accessLocked
                  ? undefined
                  : { level, caps: CAPABILITIES.filter((c) => caps[c]) },
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
