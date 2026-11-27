"use client";

import { useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import { Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import type { MemberRole } from "@/lib/permissions";
import { removeMemberAction, resendMemberInviteAction, transferOwnershipAction } from "../../clinic-actions";

export type AdminMember = {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  isOwner: boolean;
  active: boolean;
  pending: boolean;
  /** The other clinics this one login opens — a doctor at two clinics is one account. */
  elsewhere: string[];
};

/**
 * The clinic's people, from the agency's side (Admin → clinic → Members):
 * who they are, which other clinics the same login opens, and the three
 * things the agency is asked to do for them — send the invitation again, hand
 * the clinic to someone else, take someone out.
 */
export function MembersPanel({
  clinicId,
  members,
  limit,
  canEdit,
}: {
  clinicId: string;
  members: AdminMember[];
  limit: number | null;
  canEdit: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [owning, setOwning] = useState<AdminMember | null>(null);
  const [removing, setRemoving] = useState<AdminMember | null>(null);
  const active = members.filter((m) => m.active);
  const over = limit !== null && active.length > limit;

  return (
    <Card>
      <CardHeader
        title={t.admin.tabMembers}
        sub={
          limit === null
            ? `${active.length} · ${t.plans.unlimited}`
            : t.plans.usersOf.replace("{n}", String(active.length)).replace("{limit}", String(limit))
        }
      />
      {over && (
        <p className="mx-5 mb-3 rounded-lg bg-danger-soft px-3 py-2 text-[0.8125rem] text-danger" data-over-limit>
          {t.plans.overLimit.replace("{n}", String(active.length)).replace("{limit}", String(limit))}
        </p>
      )}
      <ul className="divide-y divide-line" data-admin-members>
        {active.map((m) => (
          <li key={m.id} className="grid gap-2 px-5 py-3" data-admin-member={m.email}>
            <div className="flex flex-wrap items-center gap-3">
              <Avatar name={m.name} size={32} />
              <div className="min-w-40 flex-1">
                <div className="text-sm font-medium text-ink-900">{m.name}</div>
                <div className="text-[0.75rem] text-ink-500" dir="ltr">
                  {m.email}
                </div>
                {m.elsewhere.length > 0 && (
                  <div className="mt-0.5 text-[0.75rem] text-ink-400" data-elsewhere>
                    + {m.elsewhere.join("، ")}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {m.pending && <Badge status="pending">{t.admin.pendingInvite}</Badge>}
                <Badge status={m.isOwner ? "brand" : "neutral"}>
                  {m.isOwner ? `${t.staff.roles[m.role]} · ${t.staff.owner}` : t.staff.roles[m.role]}
                </Badge>
              </div>
              {canEdit && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {m.pending && (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={pending}
                      data-resend-invite
                      onClick={() =>
                        start(async () => {
                          const r = await resendMemberInviteAction(clinicId, m.id);
                          if (r.error || !r.url) return toast(t.common.genericError, "error");
                          if (!r.emailed) setLink({ id: m.id, url: r.url });
                          toast(t.admin.inviteResent);
                        })
                      }
                    >
                      {t.admin.resendInvite}
                    </Button>
                  )}
                  {!m.isOwner && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setOwning(m)} data-make-owner>
                        {t.admin.makeOwner}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(m)} data-remove-member>
                        {t.admin.removeMember}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
            {/* The link when the email went nowhere, for the agency to send on WhatsApp. */}
            {link?.id === m.id && (
              <code dir="ltr" className="block break-all rounded-lg bg-sunken px-3 py-2 text-[0.75rem] text-ink-700 select-all" data-invite-link>
                {link.url}
              </code>
            )}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={Boolean(owning)}
        onClose={() => setOwning(null)}
        title={t.admin.makeOwnerTitle.replace("{name}", owning?.name ?? "")}
        body={t.admin.makeOwnerBody.replace(/\{name\}/g, owning?.name ?? "")}
        confirmLabel={t.admin.makeOwner}
        cancelLabel={t.common.cancel}
        danger={false}
        loading={pending}
        onConfirm={() =>
          start(async () => {
            const r = owning ? await transferOwnershipAction(clinicId, owning.id) : { error: "none" };
            setOwning(null);
            if (r.error) return toast(t.common.genericError, "error");
            toast(t.admin.ownerChanged);
          })
        }
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={t.admin.removeMemberTitle.replace("{name}", removing?.name ?? "")}
        body={t.admin.removeMemberBody}
        confirmLabel={t.admin.removeMember}
        cancelLabel={t.common.cancel}
        loading={pending}
        onConfirm={() =>
          start(async () => {
            const r = removing ? await removeMemberAction(clinicId, removing.id) : { error: "none" };
            setRemoving(null);
            if (r.error) return toast(t.common.genericError, "error");
            toast(t.admin.memberRemoved);
          })
        }
      />
    </Card>
  );
}
