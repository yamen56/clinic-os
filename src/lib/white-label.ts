import { featureSql } from "./features";

/**
 * The clinic's own brand in place of Clinicti's (Clinic Pro, `branding`,
 * 2026-11-27: "the clinic branding instead of Clinicti").
 *
 * What changes for a white-label clinic is what its *patients* see — the
 * booking page, a visit's change link, a signing link, an invoice, a receipt,
 * a printed prescription or lab order — and the staff app's own chrome: no
 * "Powered by Clinicti", page titles in the clinic's name, PDFs produced by the
 * clinic. What does not change: the privacy notice (Clinicti processes the
 * data, and the notice must stay reachable from every page that collects it),
 * the sign-in page and the password reset (one account spans clinics), and the
 * address the pages are served from (a custom domain is a separate job).
 */

/** For SQL that loads a public page's clinic: `${whiteLabelSql()} as white_label`. */
export function whiteLabelSql(alias = "cl"): string {
  return featureSql("branding", alias);
}

/** A page title in the clinic's name, with Clinicti's suffix only when it is not white-label. */
export function pageTitle(name: string, whiteLabel: boolean): { absolute: string } {
  return { absolute: whiteLabel ? name : `${name} · Clinicti` };
}

/** Who made a PDF, as its metadata says. */
export function producerName(clinicName: string, whiteLabel: boolean): string {
  return whiteLabel ? clinicName : "Clinicti";
}
