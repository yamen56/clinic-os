"use client";

import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Toggle } from "@/components/ui/input";
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
  capabilitiesFor,
  missingRequirements,
  resolveCapabilities,
  withSection,
  type Capability,
  type CapabilityArea,
  type CapabilityMap,
  type MemberRole,
} from "@/lib/permissions";
import {
  UserPlus,
  Pencil,
  Lock,
  LayoutDashboard,
  CalendarDays,
  MessageCircle,
  Users,
  FileSignature,
  ReceiptText,
  ShieldCheck,
  Coins,
  Wallet,
  Megaphone,
  Workflow,
  Sparkles,
  Settings,
  RotateCcw,
} from "lucide-react";

type Member = {
  id: string;
  role: MemberRole;
  is_owner: boolean;
  title: string | null;
  specialty: string | null;
  color: string;
  active: boolean;
  reminder_minutes: number;
  meeting_url: string | null;
  /** رقم مزاولة المهنة, and the doctors' syndicate number — printed on prescriptions. */
  license_no: string | null;
  syndicate_no: string | null;
  permissions: Record<string, unknown>;
  working_hours: Record<string, [string, string][]> | null;
  full_name: string;
  email: string;
  has_photo: boolean;
  /** They also work at another clinic here, so their name is theirs to change. */
  shared_account: boolean;
  /**
   * What this doctor earns of what they bill. Null means no arrangement, which
   * is not the same as zero.
   *
   * Always null for anybody but the clinic owner — the server does not select
   * it otherwise, so a delegated staff manager's browser never receives a
   * colleague's pay. RLS cannot help here: `members_access` admits every member
   * of a clinic to every member row.
   */
  commission_percent: string | null;
};

const ROLES: MemberRole[] = ["doctor", "receptionist", "other"];

/** The access editor's headings, in the order a working day meets them. */
const AREAS: CapabilityArea[] = ["daily", "money", "growth", "admin"];

/** The same marks the sidebar uses, so a switch is recognisably the screen it opens. */
const SECTION_ICONS: Partial<Record<Capability, React.ComponentType<{ className?: string; strokeWidth?: number }>>> = {
  dashboard: LayoutDashboard,
  calendar: CalendarDays,
  conversations: MessageCircle,
  patients: Users,
  documents: FileSignature,
  invoices: ReceiptText,
  insurance: ShieldCheck,
  earnings: Coins,
  expenses: Wallet,
  campaigns: Megaphone,
  automations: Workflow,
  ai: Sparkles,
  settings: Settings,
};

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

  /*
    Closing puts the form back to blank, whichever way it was closed. Leaving it
    filled meant abandoning a half-typed invitation and finding it again next
    time — with the access level still where the last attempt left it, so the
    next person you added quietly inherited a decision made about somebody else.
  */
  const closeAdd = () => {
    setAddOpen(false);
    resetForm();
  };

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
      <Modal open={addOpen} onClose={closeAdd} title={t.staff.addStaff} wide>
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

          {/*
            Both callbacks update through the updater form, and on this element
            in particular that is not style.

            One click on "Limited access" calls `onLevel` and then `onCaps`.
            Written as `setForm({ ...form, x })` the two calls close over the
            same `form` — the render's value, not the pending one — so React
            applied the level change and then overwrote it with a copy that
            still said `full`. The screen snapped back to full access and the
            level could not be changed at all. `setForm(f => ...)` gives the
            second call the result of the first.
          */}
          <AccessEditor
            level={form.access}
            caps={form.caps}
            role={form.role}
            onLevel={(access) => setForm((f) => ({ ...f, access }))}
            onCaps={(caps) => setForm((f) => ({ ...f, caps }))}
          />

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={closeAdd}>
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
                    /*
                      What was sent, not whether a row already existed. Somebody
                      re-adding a colleague who never accepted the first
                      invitation does have an existing account, and does get a
                      fresh invitation — telling them the email was "already
                      taken" described the database rather than what happened.
                      Somebody with an account elsewhere gets no invitation but
                      is emailed that they were added, and is told so here.
                    */
                    toast(
                      r.emailed
                        ? r.existingAccount
                          ? t.staff.addedEmailed
                          : t.staff.invited
                        : t.staff.emailTaken,
                      r.emailed ? "success" : "info"
                    );
                  }
                  setAddOpen(false);
                  resetForm();
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
            viewerIsOwner={viewerIsOwner}
            onDone={() => {
              setEditing(null);
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
  role,
  onLevel,
  onCaps,
}: {
  level: "full" | "custom";
  caps: CapabilityMap;
  /** The job, so the owner can go back to what it starts with. */
  role: MemberRole;
  onLevel: (level: "full" | "custom") => void;
  onCaps: (caps: CapabilityMap) => void;
}) {
  const { t } = useI18n();
  const sectionsOn = CAPABILITY_GROUPS.filter((g) => caps[g.section]).length;

  /** An action's own prerequisites beyond the section it sits under, said as a name. */
  const blockedBy = (cap: Capability, section: Capability) =>
    missingRequirements(caps, cap).filter((c) => c !== section);

  const setActions = (actions: Capability[], on: boolean) => {
    const next = { ...caps };
    for (const a of actions) next[a] = on && missingRequirements(next, a).length === 0;
    onCaps(next);
  };

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5">
        <div className="min-w-0 flex-1 basis-60">
          <span className="block text-sm font-semibold text-ink-900">{t.staff.accessTitle}</span>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-500">{t.staff.accessSub}</p>
        </div>
        {/*
          A segmented control: two settings, one chosen. Only the level moves.
          Switching to custom used to overwrite the ticks with *everything*,
          which was redundant in one caller and wrong in the other: a member
          stored on full already resolves to every capability, so the edit
          screen is showing all of them anyway — while on the invite form the
          ticks are the ones the chosen job implies, and replacing them handed a
          receptionist the staff-settings and export boxes the moment somebody
          looked at "Full access" and changed their mind. Nothing silently
          grants more than the screen was showing.
        */}
        <div role="radiogroup" aria-label={t.staff.accessTitle} className="flex shrink-0 rounded-full bg-ink-900/5 p-0.5">
          {(["full", "custom"] as const).map((lv) => (
            <button
              key={lv}
              type="button"
              role="radio"
              aria-checked={level === lv}
              onClick={() => onLevel(lv)}
              className={`touch-manipulation rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-140 ease-out ${
                level === lv ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
              }`}
            >
              {lv === "full" ? t.staff.fullAccess : t.staff.partialAccessLabel}
            </button>
          ))}
        </div>
      </div>

      {level === "custom" ? (
        <div className="grid gap-5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="min-w-0 flex-1 basis-64 text-[12px] leading-relaxed text-ink-500">
              {t.staff.accessCustomHint}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700 ring-1 ring-brand-100 tnum">
                {t.staff.accessSectionsOn
                  .replace("{n}", String(sectionsOn))
                  .replace("{total}", String(CAPABILITY_GROUPS.length))}
              </span>
              <button
                type="button"
                onClick={() => onCaps(capabilitiesFor(ROLE_DEFAULTS[role]))}
                className="inline-flex touch-manipulation items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t.staff.accessReset}
              </button>
            </div>
          </div>

          {AREAS.map((area) => (
            <section key={area}>
              <h4 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                {t.staff.accessAreas[area]}
              </h4>
              <div className="grid gap-2">
                {CAPABILITY_GROUPS.filter((g) => g.area === area).map(({ section, actions }) => {
                  const Icon = SECTION_ICONS[section] ?? Settings;
                  const on = caps[section];
                  const granted = actions.filter((a) => caps[a]).length;
                  return (
                    <div
                      key={section}
                      className={`rounded-xl border transition-colors duration-140 ease-out ${
                        on ? "border-brand-200 bg-brand-50/50" : "border-line"
                      }`}
                    >
                      <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                        <span
                          className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors duration-140 ease-out ${
                            on ? "bg-brand-600 text-white" : "bg-sunken text-ink-500"
                          }`}
                        >
                          <Icon className="h-4 w-4" strokeWidth={1.9} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-[13px] font-semibold text-ink-900">{t.caps[section]}</span>
                            {on && actions.length > 0 && (
                              <span className="text-[11px] font-medium text-ink-500 tnum">
                                {t.staff.accessCount
                                  .replace("{n}", String(granted))
                                  .replace("{total}", String(actions.length))}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-[12px] leading-snug text-ink-500">
                            {t.capsHelp[section]}
                          </span>
                        </span>
                        <span className="mt-1.5 shrink-0">
                          <Toggle
                            checked={on}
                            label={t.caps[section]}
                            onChange={(v) => onCaps(withSection(caps, section, v))}
                          />
                        </span>
                      </label>

                      {/*
                        Everything the section holds, shown the moment it is on —
                        switching it on ticked all of it, so this is where the
                        owner takes back what this person should not have.
                      */}
                      {on && actions.length > 0 && (
                        <div className="border-t border-brand-100 px-3 pb-2 pt-1.5">
                          <div className="flex justify-end gap-1 pb-1">
                            <button
                              type="button"
                              onClick={() => setActions(actions, true)}
                              className="touch-manipulation rounded-md px-2 py-0.5 text-[11px] font-semibold text-brand-700 hover:bg-brand-100"
                            >
                              {t.staff.accessAll}
                            </button>
                            <button
                              type="button"
                              onClick={() => setActions(actions, false)}
                              className="touch-manipulation rounded-md px-2 py-0.5 text-[11px] font-semibold text-ink-500 hover:bg-ink-900/5"
                            >
                              {t.staff.accessNone}
                            </button>
                          </div>
                          <ul className="grid gap-0.5">
                            {actions.map((a) => {
                              const missing = blockedBy(a, section);
                              return (
                                <li key={a}>
                                  <label
                                    className={`flex items-start gap-3 rounded-lg px-2 py-1.5 ${
                                      missing.length ? "opacity-60" : "cursor-pointer hover:bg-surface"
                                    }`}
                                  >
                                    <span className="min-w-0 flex-1">
                                      <span className="block text-[13px] font-medium text-ink-900">{t.caps[a]}</span>
                                      <span className="block text-[11.5px] leading-snug text-ink-500">
                                        {missing.length
                                          ? t.staff.accessNeeds.replace(
                                              "{what}",
                                              missing.map((m) => t.caps[m]).join(" · ")
                                            )
                                          : t.capsHelp[a]}
                                      </span>
                                    </span>
                                    <span className="mt-1 shrink-0">
                                      <Toggle
                                        checked={caps[a]}
                                        disabled={missing.length > 0}
                                        label={t.caps[a]}
                                        onChange={(v) => onCaps({ ...caps, [a]: v })}
                                      />
                                    </span>
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex items-start gap-3 px-4 py-4">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-600 text-white">
            <ShieldCheck className="h-4 w-4" strokeWidth={1.9} />
          </span>
          <p className="text-[13px] leading-relaxed text-ink-700">{t.staff.fullAccessHint}</p>
        </div>
      )}
    </div>
  );
}

function EditMember({
  slug,
  member,
  isSelf,
  viewerIsOwner,
  onDone,
}: {
  slug: string;
  member: Member;
  isSelf: boolean;
  viewerIsOwner: boolean;
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
  // Your own name is always yours to change, even from this screen.
  const nameLocked = member.shared_account && !isSelf;

  return (
    <div className="grid gap-4">
      <PhotoPicker
        slug={slug}
        memberId={member.id}
        name={member.full_name}
        hasPhoto={member.has_photo}
        color={m.color}
      />
      {/*
        The name, on its own row above the rest, because it is the field this
        screen was missing: it was typed once on the invitation and then fixed
        for good, and it is what appears on the calendar, on notes and on signed
        documents. Locked only when the account is shared with another clinic —
        see the guard in updateMemberAction for why that is not ours to rewrite.
      */}
      <Field label={t.staff.fullName} hint={nameLocked ? t.staff.nameShared : undefined}>
        <Input
          value={m.full_name}
          maxLength={80}
          disabled={nameLocked}
          onChange={(e) => setM({ ...m, full_name: e.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.staff.role} hint={isSelf ? t.staff.roleHint : undefined}>
          {/* Your own job is yours to set only if you own the clinic — see the
              guard in updateMemberAction. */}
          <Select
            value={m.role}
            disabled={isSelf && !viewerIsOwner}
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
            <NumberInput
              dir="ltr"
              min={0}
              max={1440}
              value={m.reminder_minutes}
              onChange={(v) => setM({ ...m, reminder_minutes: v })}
            />
          </Field>
        )}
      </div>

      {/*
        The room this person meets in, for services held online. One standing
        link rather than one per booking: the slot search already guarantees they
        are in at most one meeting at a time, so a fixed room cannot collide with
        itself — and generating one per booking would put a third-party outage
        inside the booking transaction.
      */}
      {/*
        What makes a prescription or a claim this doctor's in law rather than in
        name: the licence to practise and the syndicate membership. Printed under
        the signature on prescriptions, and what an insurer — or Hakeem Claim —
        identifies the treating doctor by.
      */}
      {m.role === "doctor" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.staff.licenseNo}>
            <Input
              dir="ltr"
              value={m.license_no ?? ""}
              onChange={(e) => setM({ ...m, license_no: e.target.value })}
            />
          </Field>
          <Field label={t.staff.syndicateNo}>
            <Input
              dir="ltr"
              value={m.syndicate_no ?? ""}
              onChange={(e) => setM({ ...m, syndicate_no: e.target.value })}
            />
          </Field>
        </div>
      )}

      {m.role === "doctor" && (
        <Field label={t.staff.meetingUrl} hint={t.staff.meetingUrlHint}>
          <Input
            dir="ltr"
            type="url"
            placeholder="https://meet.google.com/…"
            value={m.meeting_url ?? ""}
            onChange={(e) => setM({ ...m, meeting_url: e.target.value })}
          />
        </Field>
      )}

      {/*
        What the clinic pays this doctor, and the one field on this screen that
        only the owner sees. `settings.staff` is grantable — a receptionist can
        be given the staff screen without being given everyone's pay, and the
        server does not send the number to anybody else in the first place.

        Empty is not zero. Leaving it blank means there is no revenue-sharing
        arrangement and the doctor gets no earnings screen; typing 0 means there
        is one and it currently pays nothing.
      */}
      {m.role === "doctor" && viewerIsOwner && (
        <Field label={t.staff.commission} hint={t.staff.commissionHint}>
          {/*
            A plain Input, not NumberInput: that one settles an emptied box to
            its minimum, which would quietly turn "no arrangement" into "0%" —
            the one distinction this field exists to keep.
          */}
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.5}
            dir="ltr"
            placeholder={t.staff.commissionNone}
            value={m.commission_percent ?? ""}
            onChange={(e) =>
              setM({ ...m, commission_percent: e.target.value === "" ? null : e.target.value })
            }
          />
        </Field>
      )}

      {accessLocked ? (
        <p className="rounded-lg border border-line bg-sunken px-4 py-3 text-[12px] leading-relaxed text-ink-500">
          {member.is_owner ? t.staff.ownerAccessLocked : t.staff.selfAccessLocked}
        </p>
      ) : (
        <AccessEditor level={level} caps={caps} role={m.role} onLevel={setLevel} onCaps={setCaps} />
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
          disabled={!nameLocked && m.full_name.trim().length < 2}
          onClick={() =>
            start(async () => {
              const r = await updateMemberAction(slug, m.id, {
                fullName: nameLocked ? undefined : m.full_name,
                // Left absent when the field was not editable, so a save cannot
                // set something the form never offered. Whoever owns the clinic
                // may set their own job; nobody else may.
                role: isSelf && !viewerIsOwner ? undefined : m.role,
                title: m.title ?? "",
                specialty: m.specialty ?? "",
                color: m.color,
                reminderMinutes: m.reminder_minutes,
                meetingUrl: m.meeting_url ?? "",
                licenseNo: m.role === "doctor" ? (m.license_no ?? "") : undefined,
                syndicateNo: m.role === "doctor" ? (m.syndicate_no ?? "") : undefined,
                /*
                  Sent only by an owner editing a doctor, and left absent
                  otherwise so a save from any other screen state cannot clear a
                  rate it was never shown. The server refuses it from anybody
                  else regardless.
                */
                commissionPercent:
                  viewerIsOwner && m.role === "doctor"
                    ? m.commission_percent === null || m.commission_percent === ""
                      ? null
                      : Number(m.commission_percent)
                    : undefined,
                access: accessLocked
                  ? undefined
                  : { level, caps: CAPABILITIES.filter((c) => caps[c]) },
                workingHours: ownHours ? m.working_hours : null,
              });
              if (r.error) {
                toast(
                  r.error === "name_shared"
                    ? t.staff.nameShared
                    : r.error === "invalid_name"
                      ? t.profile.nameTooShort
                      : t.common.genericError,
                  "error"
                );
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
