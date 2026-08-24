import type { EinvoiceSettings } from "./settings";

/**
 * Talking to JoFotara.
 *
 * Follows the conventions every other outbound call in this codebase uses: the
 * base URL is read lazily through a function rather than captured at import
 * (the worker sets its environment after imports have run), the request always
 * carries an explicit timeout, and the error text is truncated before it goes
 * anywhere near a database column.
 */

/**
 * `JOFOTARA_BASE_URL` exists so QA can point at scripts/mock-jofotara.ts. There
 * is no ISTD sandbox host to fall back on — a taxpayer tests by creating a test
 * *device* on the same endpoint — so the default is the real one, and the mock
 * is opted into rather than out of.
 */
const BASE = () => process.env.JOFOTARA_BASE_URL || "https://backend.jofotara.gov.jo";

export type SubmitResult =
  | { ok: true; uuid: string | null; qr: string | null; number: string | null; raw: unknown }
  | { ok: false; status: number | null; error: string; raw: unknown; retryable: boolean };

/**
 * Pulls the stamp out of the response.
 *
 * Written to accept several spellings on purpose. The response field names are
 * the one part of this integration that is not confirmed against ISTD's own
 * document — that ships with the device credentials in the taxpayer's portal
 * account — so this reads the shapes the published integrations describe and
 * keeps the whole raw body either way. A rename at their end then shows up as a
 * missing QR on one invoice with the evidence attached, rather than as a
 * successful-looking submission that stamped nothing.
 */
function pick(body: unknown, keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const flat = body as Record<string, unknown>;
  for (const k of keys) {
    const v = flat[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  // One level down, since some responses nest everything under a result object.
  for (const v of Object.values(flat)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = pick(v, keys);
      if (found) return found;
    }
  }
  return null;
}

export function readStamp(body: unknown): { uuid: string | null; qr: string | null; number: string | null } {
  return {
    uuid: pick(body, ["EINV_INV_UUID", "invoice_uuid", "uuid", "UUID"]),
    qr: pick(body, ["EINV_QR", "qr_code", "qrCode", "qr", "QR"]),
    number: pick(body, ["EINV_NUM", "invoice_number", "invoiceNumber", "number"]),
  };
}

/**
 * Submits one document.
 *
 * Returns a result rather than throwing, so the caller decides what a failure
 * means. `retryable` separates "ISTD is down or slow" from "this invoice is
 * wrong" — the first deserves the job runner's backoff, the second will fail
 * identically five more times and should stop bothering the clinic.
 */
export async function submitInvoice(args: {
  settings: EinvoiceSettings;
  /** Base64 of the UBL XML. */
  payload: string;
}): Promise<SubmitResult> {
  const url = `${BASE().replace(/\/+$/, "")}/core/invoices/`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Issued per taxpayer when they create a device on the JoFotara portal.
        "Client-Id": args.settings.clientId,
        "Secret-Key": args.settings.secretKey,
      },
      body: JSON.stringify({ invoice: args.payload }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // Never reached them: a timeout, DNS, a dropped connection. Always worth retrying.
    return {
      ok: false,
      status: null,
      error: (e as Error).message.slice(0, 200),
      raw: null,
      retryable: true,
    };
  }

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 2000) };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 200) || `HTTP ${res.status}`,
      raw: body,
      /*
        4xx is the invoice, not the weather. A rejected document is rejected
        deterministically — retrying it four more times only delays the moment
        somebody is told, and buries the real error under identical ones.
        401 is the exception in spirit but not in treatment: wrong credentials
        will not fix themselves either.
      */
      retryable: res.status >= 500 || res.status === 429,
    };
  }

  const stamp = readStamp(body);
  return { ok: true, ...stamp, raw: body };
}
