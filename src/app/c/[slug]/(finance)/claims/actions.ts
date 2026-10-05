"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";
import { invoiceScopeSql } from "@/lib/invoice-scope";
import { refreshInvoiceStatus, round2 } from "@/lib/invoices";
import { enqueueEinvoiceSubmit } from "@/lib/einvoice/jobs";
import type { PoolClient } from "pg";
import type { ClinicAccess } from "@/lib/auth";

/**
 * Working the claims list in bulk.
 *
 * Both actions take a selection, because that is how the work arrives: the
 * month's claims go to a company together, and its payment covers a batch.
 * Opening forty invoices one by one to say the same thing forty times is the
 * chore this screen exists to remove.
 *
 * Every id is re-checked against this member's own scope — the list they saw
 * proves nothing about the ids that come back.
 */

const MAX_BATCH = 200;

/** The ids from the request that this member may touch, as claims. */
async function allowedClaims(c: PoolClient, access: ClinicAccess, ids: string[]): Promise<string[]> {
  const clean = [...new Set(ids.filter(isUuid))].slice(0, MAX_BATCH);
  if (!clean.length) return [];
  const scope = invoiceScopeSql(access, "i", 3);
  return (
    await c.query(
      `select i.id from invoices i
        where i.id = any($1::uuid[]) and i.clinic_id = $2
          and i.claim_status <> 'none' and i.status <> 'void'${scope.sql}`,
      [clean, access.clinicId, ...scope.params]
    )
  ).rows.map((r) => r.id as string);
}

const SETTABLE = ["to_submit", "submitted", "approved", "rejected"] as const;

export async function setClaimStatusAction(
  slug: string,
  ids: string[],
  status: string,
  note?: string
): Promise<{ updated?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  if (!(SETTABLE as readonly string[]).includes(status)) return { error: "bad_status" };

  return inClinic(access, async (c) => {
    const allowed = await allowedClaims(c, access, ids);
    if (!allowed.length) return { updated: 0 };
    /*
      Paid is not settable here: a company paying is money arriving, and that
      belongs in the payments ledger — see markClaimsPaidAction. A rejection
      keeps its reason, because "why" is the whole of what reception needs to
      resubmit it.
    */
    await c.query(
      `update invoices
          set claim_status = $3,
              claim_submitted_at = case when $3 = 'submitted' and claim_submitted_at is null
                                        then now() else claim_submitted_at end,
              claim_note = case when $4::text is null then claim_note else $4 end
        where id = any($1::uuid[]) and clinic_id = $2`,
      [allowed, access.clinicId, status, note?.trim() ? note.trim().slice(0, 500) : null]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "claim.status",
      entity: "clinic",
      entityId: access.clinicId,
      detail: { status, invoices: allowed },
    });
    revalidatePath(`/c/${slug}/claims`);
    return { updated: allowed.length };
  });
}

/**
 * A company paid: record its money against each claim it covers.
 *
 * Recorded as a real payment on each invoice — the insurer's share, or what is
 * left owing if that is less — so the invoice settles, the balance on the
 * patient's file stops counting money the company already paid, and earnings
 * see it as collected. By transfer, which is how a company pays; the reference
 * names the company and whatever the clinic typed (the transfer number,
 * usually). The patient is not messaged: this is between the clinic and the
 * insurer.
 */
export async function markClaimsPaidAction(
  slug: string,
  ids: string[],
  data: { reference?: string; paidOn?: string }
): Promise<{ paid?: number; amount?: number; error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "invoices")) return { error: "forbidden" };
  const paidOn = data.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(data.paidOn) ? data.paidOn : null;

  return inClinic(access, async (c) => {
    const allowed = await allowedClaims(c, access, ids);
    let paid = 0;
    let amountTotal = 0;
    for (const id of allowed) {
      const inv = (
        await c.query(
          `select i.id, i.patient_id, i.total, i.amount_paid, i.insurer_amount, i.claim_status,
                  ins.name as insurer_name
             from invoices i left join insurers ins on ins.id = i.insurer_id
            where i.id = $1 and i.clinic_id = $2 for update of i`,
          [id, access.clinicId]
        )
      ).rows[0];
      if (!inv || inv.claim_status === "paid") continue;
      const amount = round2(
        Math.min(Number(inv.insurer_amount), Number(inv.total) - Number(inv.amount_paid))
      );
      if (amount > 0) {
        const reference = [inv.insurer_name, data.reference?.trim()].filter(Boolean).join(" · ").slice(0, 100);
        await c.query(
          `insert into payments (clinic_id, invoice_id, patient_id, amount, method, reference, paid_at, recorded_by)
           values ($1, $2, $3, $4, 'transfer', $5,
                   coalesce(($6::date + time '12:00') at time zone (select timezone from clinics where id = $1), now()),
                   $7)`,
          [access.clinicId, id, inv.patient_id, amount, reference, paidOn, access.session.user.id]
        );
        await refreshInvoiceStatus(c, id);
        // A sale that became real; filing decides cash or receivable as usual.
        await enqueueEinvoiceSubmit(c, access.clinicId, id, "paid");
        amountTotal = round2(amountTotal + amount);
      }
      await c.query(`update invoices set claim_status = 'paid' where id = $1 and clinic_id = $2`, [
        id,
        access.clinicId,
      ]);
      paid++;
    }
    if (paid) {
      await audit(c, {
        clinicId: access.clinicId,
        userId: access.session.user.id,
        impersonatedBy: access.session.impersonatedBy,
        action: "claim.paid",
        entity: "clinic",
        entityId: access.clinicId,
        detail: { invoices: allowed, amount: amountTotal, reference: data.reference ?? "" },
      });
    }
    revalidatePath(`/c/${slug}/claims`);
    revalidatePath(`/c/${slug}/invoices`);
    return { paid, amount: amountTotal };
  });
}
