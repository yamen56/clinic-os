"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteMyAccountAction } from "./actions";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Trash2, AlertTriangle } from "lucide-react";

/**
 * The last thing on the profile screen, and deliberately the plainest.
 *
 * It sits below sign-out because it is the neighbour of sign-out in intent and
 * the opposite of it in consequence, and the two must not be mistaken for each
 * other on a phone. So this is a bordered link-weight control rather than a
 * filled danger button: a red slab next to "Sign out" invites the thumb, and
 * this is not something to invite.
 *
 * An owner sees it too, and sees why it will not work for them. Hiding it would
 * be the friendlier-looking choice and the worse one — somebody who came here
 * to close their account and finds nothing concludes the product will not let
 * them, which is both wrong and exactly the complaint the right of erasure
 * exists to answer.
 */
export function DeleteAccount({
  slug,
  email,
  isOwner,
}: {
  slug: string;
  email: string;
  isOwner: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const td = t.deleteAccount;

  const close = () => {
    setOpen(false);
    setTyped("");
    setError(null);
  };

  const run = () =>
    start(async () => {
      const r = await deleteMyAccountAction(slug, typed);
      if (r.error) {
        setError(r.error === "owner" ? td.ownerBlocked : td.emailMismatch);
        return;
      }
      /*
        The action already cleared the cookie, so this is a navigation and not a
        sign-out. `refresh` first: without it the client router can serve the
        profile screen for an account that no longer exists from its cache.
      */
      router.refresh();
      router.replace("/login");
    });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full touch-manipulation items-center justify-center gap-2 rounded-card border border-line bg-surface px-4 py-3 text-sm font-medium text-ink-500 transition-colors duration-140 ease-out hover:border-danger/40 hover:bg-danger-soft hover:text-danger"
      >
        <Trash2 className="h-4 w-4" />
        {td.cta}
      </button>

      <Modal open={open} onClose={close} title={td.title}>
        <div className="grid gap-4">
          {isOwner ? (
            <div className="flex items-start gap-2.5 rounded-ctl bg-sunken px-3.5 py-3 text-[13px] leading-relaxed text-ink-600">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span className="min-w-0">{td.ownerBlocked}</span>
            </div>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-ink-600">{td.body}</p>
              {/*
                Said plainly, because it is the part people are surprised by
                later: the notes stay. They are the patient's record and have
                their own retention period; what goes is the name attached.
              */}
              <p className="text-[13px] leading-relaxed text-ink-500">{td.recordsKept}</p>

              <Field label={td.confirmLabel}>
                <Input
                  dir="ltr"
                  autoComplete="off"
                  placeholder={email}
                  value={typed}
                  onChange={(e) => {
                    setTyped(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
            </>
          )}

          {error && <p className="text-[13px] text-danger">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={pending}>
              {t.common.cancel}
            </Button>
            {!isOwner && (
              <Button
                variant="danger"
                onClick={run}
                disabled={pending || typed.trim().toLowerCase() !== email.trim().toLowerCase()}
              >
                {pending ? t.common.saving : td.confirm}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
