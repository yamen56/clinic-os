"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteClinicAction, restoreClinicAction, purgeClinicAction } from "../../actions";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { RESTORE_WINDOW_DAYS, daysUntilPurge } from "@/lib/clinic-lifecycle";
import { Trash2, RotateCcw, AlertTriangle } from "lucide-react";

type Mode = "delete" | "purge";

/**
 * Deleting a clinic, and taking it back.
 *
 * The typed slug is the whole safety design. A confirm dialog is dismissed by
 * reflex — the second one in a session is not read at all — whereas typing
 * `bright-smile-amman` cannot be done by a hand that thought it was on a
 * different row. The server checks it too; this is the part that makes somebody
 * look at the name, not the part that enforces anything.
 */
export function DangerZone({
  clinic,
}: {
  clinic: { id: string; slug: string; deletedAt: string | null };
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [restorePending, startRestore] = useTransition();

  const close = () => {
    setMode(null);
    setTyped("");
    setError(null);
  };

  const errorText = (code: string) =>
    (t.admin.deleteErrors as Record<string, string>)[code] ?? t.common.genericError;

  const run = (m: Mode) =>
    start(async () => {
      const r =
        m === "delete"
          ? await deleteClinicAction(clinic.id, typed)
          : await purgeClinicAction(clinic.id, typed);
      if (r.error) {
        setError(errorText(r.error));
        return;
      }
      toast(m === "delete" ? t.admin.deleted : t.admin.purged);
      close();
      // A purged clinic's page no longer exists, so there is nowhere to refresh
      // back to; the list is the only honest destination.
      if (m === "purge") router.push("/admin");
      else router.refresh();
    });

  if (clinic.deletedAt) {
    const left = daysUntilPurge(clinic.deletedAt);
    return (
      <>
        <Card className="mt-4 border-danger/30">
          <CardHeader
            title={
              <span className="flex items-center gap-2 text-danger">
                <AlertTriangle className="h-4 w-4" />
                {t.admin.deleted}
              </span>
            }
            /*
              Both of these are read off the client's clock and calendar — the
              date in the viewer's timezone, the countdown against "now" — so
              the server's render and the browser's can legitimately disagree by
              a day. Suppressed rather than frozen server-side: the number a
              person is deciding whether to restore by should be their number.
            */
            sub={
              <span suppressHydrationWarning>
                {t.admin.deletedOn.replace(
                  "{date}",
                  new Date(clinic.deletedAt).toLocaleDateString(
                    locale === "en" ? "en-GB" : "ar-JO"
                  )
                )}
              </span>
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-[13px] text-ink-500" suppressHydrationWarning>
              {left > 0 ? t.admin.purgeIn.replace("{n}", String(left)) : t.admin.purgeDueNow}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                loading={restorePending}
                onClick={() =>
                  startRestore(async () => {
                    const r = await restoreClinicAction(clinic.id);
                    if (r.error) return toast(errorText(r.error));
                    toast(t.admin.restored);
                    router.refresh();
                  })
                }
              >
                <RotateCcw className="h-4 w-4" />
                {t.admin.restoreClinic}
              </Button>
              <Button variant="danger" onClick={() => setMode("purge")}>
                <Trash2 className="h-4 w-4" />
                {t.admin.purgeNow}
              </Button>
            </div>
          </div>
        </Card>
        {confirmModal("purge")}
      </>
    );
  }

  return (
    <>
      <Card className="mt-4 border-danger/20">
        <CardHeader title={<span className="text-danger">{t.admin.dangerZone}</span>} />
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
          <p className="max-w-lg text-[13px] leading-relaxed text-ink-500">
            {t.admin.deleteClinicBody.replace("{days}", String(RESTORE_WINDOW_DAYS))}
          </p>
          <Button variant="danger" onClick={() => setMode("delete")}>
            <Trash2 className="h-4 w-4" />
            {t.admin.deleteClinic}
          </Button>
        </div>
      </Card>
      {confirmModal("delete")}
    </>
  );

  function confirmModal(m: Mode) {
    return (
      <Modal
        open={mode === m}
        onClose={close}
        title={m === "delete" ? t.admin.deleteClinic : t.admin.purgeNow}
      >
        <div className="grid gap-4">
          <p className="text-sm leading-relaxed text-ink-700">
            {m === "delete"
              ? t.admin.deleteClinicBody.replace("{days}", String(RESTORE_WINDOW_DAYS))
              : t.admin.purgeNowBody.replace("{days}", String(RESTORE_WINDOW_DAYS))}
          </p>
          <Field
            label={t.admin.deleteConfirmLabel.replace("{slug}", clinic.slug)}
            error={error ?? undefined}
          >
            <Input
              dir="ltr"
              autoFocus
              value={typed}
              placeholder={clinic.slug}
              onChange={(e) => {
                setTyped(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              loading={pending}
              // Disabled until it matches, so the button itself is the last
              // confirmation rather than a rejection message after the fact.
              disabled={typed.trim() !== clinic.slug}
              onClick={() => run(m)}
            >
              {m === "delete" ? t.admin.deleteClinic : t.admin.purgeNow}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }
}
