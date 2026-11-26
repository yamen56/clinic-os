/**
 * The lab order, as it leaves the clinic (2026-11-26).
 *
 * A dentist sends work to an outside lab over WhatsApp, with the order on
 * paper or as a PDF: which teeth, what is to be made, the shade, when it is
 * wanted back. Clinicti writes that order from the chart (lab-server.ts keeps
 * what the lab was told), draws it as a PDF (/lab-print), and hands the clinic
 * a link to it, for the message to the lab and for Print.
 *
 * The lab has no account here, so the link carries its own key: an HMAC over
 * the case, good for sixty days — long enough for a bridge's trips to the lab
 * and back. Nothing is stored, so there is nothing to leak from a table; a
 * cancelled case stops opening (/lab-order). The order carries the patient's
 * name and the work, and nothing else of the patient: no phone number, no
 * medical history, no money.
 *
 * Server only: the key is signed with the internal secret.
 */

import { printKeyFor } from "@/lib/print-token";
import { appUrl } from "@/lib/urls";
import type { LabCase } from "./labs";

/** How long the link sent to the lab opens its order. */
export const ORDER_LINK_DAYS = 60;
export const ORDER_KIND = "lab-order";
/** The key the renderer opens the order's page with: minutes, like every print page. */
export const PRINT_KIND = "lab-print";

export function labOrderUrl(caseId: string): string {
  const { exp, sig } = printKeyFor(caseId, ORDER_KIND, ORDER_LINK_DAYS * 86_400_000);
  return `${appUrl()}/lab-order/${caseId}?exp=${exp}&sig=${sig}`;
}

/** The case as the clinic sees it, with the link its lab is sent. */
export function withOrderUrl<T extends LabCase>(c: T): T {
  return c.status === "cancelled" ? c : { ...c, orderUrl: labOrderUrl(c.id) };
}
