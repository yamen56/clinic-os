"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { fmtRelative } from "@/lib/dates";
import {
  ADMIN_CAPABILITIES,
  ADMIN_CAPABILITY_GROUPS,
  ADMIN_PRESETS,
  adminCapabilitiesFor,
  adminLevelOf,
  allAdminCapabilities,
  resolveAdminCapabilities,
  type AdminCapability,
  type AdminCapabilityMap,
} from "@/lib/admin-permissions";
import {
  inviteAdminAction,
  updateAdminAccessAction,
  revokeAdminAction,
  resendAdminInviteAction,
} from "./actions";
import { UserPlus, Pencil, Lock, ShieldCheck, Copy, Check } from "lucide-react";

type Admin = {
  id: string;
  fullName: string;
  email: string;
  permissions: Record<string, unknown>;
  invitePending: boolean;
  clinicCount: number;
  lastSession: string | null;
};

export function TeamClient({ admins, selfId }: { admins: Admin[]; selfId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Admin | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<Admin | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const [form, setForm] = useState({
    fullName: "",
    email: "",
    level: "custom" as "full" | "custom",
    caps: adminCapabilitiesFor(ADMIN_PRESETS[0].caps),
  });

  /*
    Whether limiting or removing this person would leave the panel with nobody
    able to grant access back. The server refuses it either way — this only
    decides whether the reason is visible before the click or after it.
  */
  const fullAdmins = admins.filter((a) => adminLevelOf(a.permissions) === "full");
  const isLastFull = (a: Admin) =>
    fullAdmins.length === 1 && fullAdmins[0].id === a.id;

  const errText = (code: string) =>
    (t.admin.teamErrors as Record<string, string>)[code] ?? t.common.genericError;

  const summary = (a: Admin) => {
    if (adminLevelOf(a.permissions) === "full") return t.admin.adminFullAccess;
    const caps = resolveAdminCapabilities(a.permissions, { isSuperAdmin: true });
    const n = ADMIN_CAPABILITIES.filter((c) => caps[c]).length;
    return t.admin.adminLimitedCount
      .replace("{n}", String(n))
      .replace("{total}", String(ADMIN_CAPABILITIES.length));
  };

  const openAdd = () => {
    setForm({
      fullName: "",
      email: "",
      level: "custom",
      caps: adminCapabilitiesFor(ADMIN_PRESETS[0].caps),
    });
    setError(null);
    setInviteLink(null);
    setAddOpen(true);
  };

  const openEdit = (a: Admin) => {
    const level = adminLevelOf(a.permissions);
    setForm({
      fullName: a.fullName,
      email: a.email,
      level,
      // A full admin's stored caps are `{}` — every box would render unticked,
      // which is not what "full access" means. Expand it first, so switching to
      // limited starts from everything and you take things away.
      caps:
        level === "full"
          ? allAdminCapabilities()
          : resolveAdminCapabilities(a.permissions, { isSuperAdmin: true }),
    });
    setError(null);
    setEditing(a);
  };

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={openAdd}>
          <UserPlus className="h-4 w-4" />
          {t.admin.addAdmin}
        </Button>
      </div>

      <div className="grid gap-3">
        {admins.map((a) => {
          const isSelf = a.id === selfId;
          return (
            <Card key={a.id} className="flex flex-wrap items-center gap-4 p-4">
              <Avatar name={a.fullName} size={40} />
              <div className="min-w-40 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.fullName}</span>
                  {isSelf && <Badge status="brand">{t.admin.adminYou}</Badge>}
                  {a.invitePending && <Badge status="pending">{t.admin.ownerInvitePending}</Badge>}
                </div>
                <div className="text-[13px] text-ink-500" dir="ltr">
                  {a.email}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {a.clinicCount > 0 && (
                  // Worth surfacing: this person is also somebody's staff, so
                  // removing them from the agency must not touch that.
                  <Badge status="neutral">
                    {a.clinicCount} {t.admin.clinics.toLowerCase()}
                  </Badge>
                )}
                {a.lastSession && (
                  <span className="text-[12px] text-ink-400" suppressHydrationWarning>
                    {fmtRelative(a.lastSession, locale)}
                  </span>
                )}
                <Badge status={adminLevelOf(a.permissions) === "full" ? "ok" : "neutral"}>
                  {summary(a)}
                </Badge>
                {a.invitePending && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      start(async () => {
                        const r = await resendAdminInviteAction(a.id);
                        if (r.error) return toast(errText(r.error));
                        setInviteLink(r.url ?? null);
                        toast(t.admin.adminInvited);
                      })
                    }
                  >
                    {t.admin.resendInvite}
                  </Button>
                )}
                {isSelf ? (
                  <span
                    className="grid h-9 w-9 place-items-center text-ink-300"
                    title={t.admin.adminSelfLocked}
                  >
                    <Lock className="h-4 w-4" />
                  </span>
                ) : (
                  <Button variant="ghost" size="icon" onClick={() => openEdit(a)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {inviteLink && (
        <InviteLink url={inviteLink} onDone={() => setInviteLink(null)} />
      )}

      {/* ------------------------------------------------------------- add */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t.admin.addAdmin}>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.common.name} required>
              <Input
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              />
            </Field>
            <Field label={t.common.email} required>
              <Input
                type="email"
                dir="ltr"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
          </div>

          <AccessEditor form={form} setForm={setForm} />

          <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-500">
            {t.admin.adminInviteHint}
          </p>
          {error && (
            <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              loading={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await inviteAdminAction({
                    fullName: form.fullName,
                    email: form.email,
                    level: form.level,
                    caps: form.caps,
                  });
                  if (r.error) return setError(errText(r.error));
                  setAddOpen(false);
                  toast(t.admin.adminInvited);
                  if (r.url && !r.emailed) setInviteLink(r.url);
                  router.refresh();
                })
              }
            >
              {t.common.add}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------------------ edit */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.fullName ?? t.admin.adminAccess}
      >
        {editing && (
          <div className="grid gap-4">
            <AccessEditor form={form} setForm={setForm} />

            {isLastFull(editing) && (
              <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-500">
                {t.admin.lastAdmin}
              </p>
            )}
            {error && (
              <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="ghost"
                className="text-danger hover:bg-danger-soft"
                disabled={isLastFull(editing)}
                onClick={() => {
                  setConfirmRevoke(editing);
                  setEditing(null);
                }}
              >
                {t.admin.revokeAdmin}
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setEditing(null)}>
                  {t.common.cancel}
                </Button>
                <Button
                  loading={pending}
                  onClick={() =>
                    start(async () => {
                      setError(null);
                      const r = await updateAdminAccessAction({
                        userId: editing.id,
                        level: form.level,
                        caps: form.caps,
                      });
                      if (r.error) return setError(errText(r.error));
                      setEditing(null);
                      toast(t.common.saved);
                      router.refresh();
                    })
                  }
                >
                  {t.common.save}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------------------------------------------------------- revoke */}
      <Modal
        open={!!confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        title={t.admin.revokeAdmin}
      >
        {confirmRevoke && (
          <div className="grid gap-4">
            <p className="text-sm leading-relaxed text-ink-700">{t.admin.revokeAdminBody}</p>
            <div className="flex items-center gap-2.5 rounded-ctl border border-line px-3 py-2.5">
              <Avatar name={confirmRevoke.fullName} size={30} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{confirmRevoke.fullName}</div>
                <div className="truncate text-[12px] text-ink-500" dir="ltr">
                  {confirmRevoke.email}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmRevoke(null)}>
                {t.common.cancel}
              </Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await revokeAdminAction(confirmRevoke.id);
                    if (r.error) {
                      toast(errText(r.error));
                      return;
                    }
                    setConfirmRevoke(null);
                    toast(t.admin.revoked);
                    router.refresh();
                  })
                }
              >
                {t.admin.revokeAdmin}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/* -------------------------------------------------------------------------- */

type FormState = {
  fullName: string;
  email: string;
  level: "full" | "custom";
  caps: AdminCapabilityMap;
};

/**
 * Full or limited, and which switches.
 *
 * Same two-level shape as the clinic's staff screen. `full` is not "every box
 * ticked" — it explicitly means "and anything added later", so a capability
 * that ships next month reaches a full admin without anybody revisiting this
 * dialog. A limited admin gets exactly what is ticked and nothing more, which
 * is the entire reason for the distinction.
 */
function AccessEditor({
  form,
  setForm,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
}) {
  const { t } = useI18n();
  const capLabel = (c: AdminCapability) => (t.admin.adminCaps as Record<string, string>)[c] ?? c;
  const groupLabel = (k: string) => (t.admin.adminCapGroups as Record<string, string>)[k] ?? k;

  return (
    <div className="grid gap-3">
      <div className="text-sm font-medium text-ink-900">{t.admin.adminAccess}</div>

      <div className="grid gap-2">
        {(["full", "custom"] as const).map((lvl) => (
          <label
            key={lvl}
            className={`flex cursor-pointer items-start gap-2.5 rounded-ctl border px-3 py-2.5 transition-colors ${
              form.level === lvl ? "border-brand-600 bg-brand-100/40" : "border-line"
            }`}
          >
            <input
              type="radio"
              name="admin-level"
              className="mt-0.5 accent-brand-600"
              checked={form.level === lvl}
              onChange={() => setForm({ ...form, level: lvl })}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {lvl === "full" && <ShieldCheck className="h-4 w-4 text-brand-600" />}
                {lvl === "full" ? t.admin.adminFullAccess : t.admin.adminLimited}
              </span>
              {lvl === "full" && (
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-500">
                  {t.admin.adminFullAccessHint}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      {form.level === "custom" && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-ink-400">{t.admin.adminPresets}</span>
            {ADMIN_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setForm({ ...form, caps: adminCapabilitiesFor(p.caps) })}
                className="rounded-full border border-line px-2.5 py-1 text-[12px] font-medium text-ink-700 transition-colors hover:bg-brand-100 hover:text-brand-700"
              >
                {(t.admin.presets as Record<string, string>)[p.key] ?? p.key}
              </button>
            ))}
          </div>

          <div className="grid gap-3 rounded-ctl border border-line p-3">
            {ADMIN_CAPABILITY_GROUPS.map((g) => (
              <div key={g.key}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                  {groupLabel(g.key)}
                </div>
                <div className="grid gap-1">
                  {g.caps.map((c) => (
                    <label
                      key={c}
                      className="flex cursor-pointer items-center gap-2.5 rounded-ctl px-1.5 py-1.5 hover:bg-sunken"
                    >
                      <span className="flex-1 text-[13px]">{capLabel(c)}</span>
                      <Toggle
                        checked={form.caps[c] === true}
                        label={capLabel(c)}
                        onChange={(v) => setForm({ ...form, caps: { ...form.caps, [c]: v } })}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The invitation link, shown when the email could not be sent.
 *
 * Not a fallback worth hiding: a mail provider that is not configured yet, or
 * an address that bounces, otherwise leaves a new colleague with an account
 * they can never get into and no way to fix it but deleting them.
 */
function InviteLink({ url, onDone }: { url: string; onDone: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Card className="mt-4 p-4">
      <div className="mb-2 text-[13px] text-ink-500">{t.admin.inviteLinkCopy}</div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-ctl bg-sunken px-3 py-2 text-[12px]" dir="ltr">
          {url}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? t.common.done : t.common.copy}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t.common.close}
        </Button>
      </div>
    </Card>
  );
}
