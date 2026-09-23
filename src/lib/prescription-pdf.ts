import { renderUrlToPdf } from "./pdf";
import { printKeyFor } from "./print-token";
import { saveFile } from "./storage";
import { appUrl } from "./urls";
import { rxNumber } from "./prescriptions";

/**
 * Renders a prescription's PDF and stores it, returning the storage key.
 *
 * Its own file rather than a function in `prescriptions.ts`, which the composer
 * imports in the browser: this one reaches the renderer and the object store.
 *
 * Called outside any transaction. Chromium visits the print page over HTTP and
 * can take seconds, and a database connection held open for that is how a slow
 * render becomes an outage — the invoice send learned this first.
 *
 * Returns null rather than throwing. By the time this runs the prescription is
 * already a record, and a failed render must not read as a failed prescription:
 * the caller says so, and the next Print or Resend tries again.
 */
export async function renderPrescriptionPdf(
  clinicId: string,
  prescriptionId: string,
  number: number
): Promise<string | null> {
  const { exp, sig } = printKeyFor(prescriptionId, "prescription");
  try {
    const pdf = await renderUrlToPdf(
      `${appUrl()}/rx-print/${prescriptionId}?kind=prescription&exp=${exp}&sig=${sig}`
    );
    const saved = await saveFile(clinicId, "prescriptions", `${rxNumber(number)}.pdf`, pdf);
    return saved.storagePath;
  } catch (e) {
    console.error("[prescription pdf]", (e as Error).message);
    return null;
  }
}
