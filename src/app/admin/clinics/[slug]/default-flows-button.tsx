"use client";

/*
  Switches the default flows on for a clinic that is already running — the
  reminders, for the pilot clinics. A confirm first: from the moment it is
  pressed this clinic's patients start receiving the messages listed above it.
*/

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { applyDefaultFlowsAction } from "../../actions";

export function DefaultFlowsButton({ slug, count, locale }: { slug: string; count: number; locale: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const ar = locale !== "en";
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-apply-default-flows>
        {ar ? `تشغيل ${count}` : `Switch on ${count}`}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={ar ? "تشغيل التدفقات الافتراضية؟" : "Switch the default flows on?"}
        body={
          ar
            ? "سيبدأ مرضى هذه العيادة باستلام هذه الرسائل على واتساب من الآن."
            : "This clinic's patients start receiving these WhatsApp messages from now on."
        }
        confirmLabel={ar ? "تشغيل" : "Switch on"}
        cancelLabel={ar ? "إلغاء" : "Cancel"}
        danger={false}
        loading={pending}
        onConfirm={() =>
          start(async () => {
            const r = await applyDefaultFlowsAction(slug);
            setOpen(false);
            if (r.error) toast(r.error, "error");
            else {
              toast(ar ? `شُغّل ${r.installed}` : `${r.installed} switched on`);
              router.refresh();
            }
          })
        }
      />
    </>
  );
}
