import { renderUrlToPdf } from "./pdf";
import { printKeyFor } from "./print-token";
import { saveFile } from "./storage";
import { appUrl } from "./urls";
import { letterNumber } from "./medical-letters";

/**
 * Renders a medical letter's PDF and stores it, returning the storage key.
 *
 * The prescription's twin (lib/prescription-pdf): outside any transaction,
 * because Chromium visits the print page over HTTP and can take seconds, and
 * null rather than a throw, because the letter is already a record by now.
 */
export async function renderLetterPdf(clinicId: string, letterId: string, number: number): Promise<string | null> {
  const { exp, sig } = printKeyFor(letterId, "letter");
  try {
    const pdf = await renderUrlToPdf(`${appUrl()}/letter-print/${letterId}?kind=letter&exp=${exp}&sig=${sig}`);
    const saved = await saveFile(clinicId, "letters", `${letterNumber(number)}.pdf`, pdf);
    return saved.storagePath;
  } catch (e) {
    console.error("[letter pdf]", (e as Error).message);
    return null;
  }
}
