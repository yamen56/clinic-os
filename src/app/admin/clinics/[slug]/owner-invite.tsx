"use client";

import { useState, useTransition } from "react";
import { resendOwnerInviteAction } from "../../actions";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Send } from "lucide-react";

/**
 * Re-sending the owner's invitation.
 *
 * Shown only while the owner has not chosen a password, which is the only state
 * where an invitation means anything. When mail is not configured the action
 * hands back the link instead of a failure, and it is rendered here for the
 * agency to pass on — a clinic is never stranded because Resend is not set up.
 */
export function OwnerInvite({ clinicId }: { clinicId: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [link, setLink] = useState<string | null>(null);

  return (
    <div className="grid gap-2">
      <Button
        variant="outline"
        size="sm"
        loading={pending}
        onClick={() =>
          start(async () => {
            const r = await resendOwnerInviteAction(clinicId);
            if (r.error) return toast(r.error, "error");
            if (r.emailed) toast(t.admin.inviteSent, "success");
            if (r.url) setLink(r.url);
          })
        }
      >
        <Send className="h-4 w-4" />
        {t.admin.resendInvite}
      </Button>
      {link && (
        <div className="grid gap-1 rounded-md bg-sunken px-3 py-2 text-[13px]">
          <span className="text-ink-500">{t.admin.inviteLinkCopy}</span>
          {/* Selectable rather than a link: it is meant to be copied and sent,
              and opening it here would burn the token on the wrong person. */}
          <code className="break-all font-mono text-[12px] text-ink-900 select-all" dir="ltr">
            {link}
          </code>
        </div>
      )}
    </div>
  );
}
