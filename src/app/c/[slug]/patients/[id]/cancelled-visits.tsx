"use client";

/*
  A patient's cancelled visits, folded under the rest of the Appointments tab
  (Yamen, 2026-11-20: cancelled items only showed, and could not be cleared).
  Open, they are the same rows as any visit; the ones nothing was recorded
  under can be deleted together. The action revalidates the file, so nothing
  here refreshes it.
*/

import { useState, type ReactNode } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { deleteCancelledAppointmentsAction } from "../../calendar/actions";
import type { RowAppointment } from "./appointment-row";

export function CancelledVisits({
  slug,
  patientId,
  rows,
  canDelete,
  renderRow,
}: {
  slug: string;
  patientId: string;
  rows: RowAppointment[];
  /** `calendar`: whoever may cancel a visit may clear the cancelled ones. */
  canDelete: boolean;
  renderRow: (a: RowAppointment) => ReactNode;
}) {
  const { t } = useI18n();
  const P = t.patients;
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!rows.length) return null;
  const deletable = rows.filter((a) => a.deletable).map((a) => a.id);
  const n = String(deletable.length);

  return (
    <li className="bg-canvas" data-cancelled-visits={rows.length}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-1.5 sm:px-5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex min-h-10 touch-manipulation items-center gap-1.5 text-[13px] font-semibold text-ink-500 hover:text-ink-700"
          data-cancelled-visits-toggle
        >
          <ChevronDown className={`h-4 w-4 transition-transform duration-140 ${open ? "rotate-180" : ""}`} />
          {P.cancelledVisitsN.replace("{n}", String(rows.length))}
        </button>
        {open && canDelete && deletable.length > 0 && (
          <Button variant="ghost" size="sm" className="!text-danger" onClick={() => setConfirm(true)} data-delete-cancelled-visits={deletable.length}>
            <Trash2 className="h-4 w-4" />
            {P.deleteCancelledVisits.replace("{n}", n)}
          </Button>
        )}
      </div>
      {open && <ul className="divide-y divide-line border-t border-line">{rows.map(renderRow)}</ul>}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={P.deleteCancelledVisitsTitle.replace("{n}", n)}
        body={P.deleteCancelledVisitsBody}
        confirmLabel={P.deleteCancelledVisits.replace("{n}", n)}
        cancelLabel={t.common.cancel}
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          const r = await deleteCancelledAppointmentsAction(slug, patientId, deletable);
          setBusy(false);
          setConfirm(false);
          if (r.error) toast(t.common.genericError, "error");
          else toast(P.deletedVisitsN.replace("{n}", String(r.deleted ?? 0)));
        }}
      />
    </li>
  );
}
