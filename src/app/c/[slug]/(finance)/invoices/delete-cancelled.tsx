"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { deleteCancelledInvoicesAction } from "./actions";

/**
 * "Delete cancelled invoices (n)", under the Cancelled chip. `count` is how many
 * may go — the ones never filed with JoFotara; the action deletes exactly those.
 * The action revalidates the list, so nothing here refreshes it.
 */
export function DeleteCancelled({ slug, count }: { slug: string; count: number }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = String(count);

  return (
    <>
      <Button variant="ghost" size="sm" className="!text-danger" onClick={() => setOpen(true)} data-delete-cancelled={count}>
        <Trash2 className="h-4 w-4" />
        {t.invoices.deleteAllCancelled.replace("{n}", n)}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.invoices.deleteAllConfirm.replace("{n}", n)}
        body={t.invoices.deleteAllBody}
        confirmLabel={t.invoices.deleteAllCancelled.replace("{n}", n)}
        cancelLabel={t.common.cancel}
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          const r = await deleteCancelledInvoicesAction(slug);
          setBusy(false);
          setOpen(false);
          if (r.error) toast(t.common.genericError, "error");
          else toast(t.invoices.deletedN.replace("{n}", String(r.deleted ?? 0)));
        }}
      />
    </>
  );
}
