/**
 * Invoice PDF rendering, delegated to the worker.
 *
 * The renderer itself lives in `worker/pdf.ts` because it needs a headless
 * Chromium, which exceeds a Vercel function's size limit and cannot be launched
 * in a serverless sandbox. The worker already runs Chromium and is always-on, so
 * the web app posts the print URL to it and gets the bytes back.
 *
 * The print page authenticates with the invoice's public token, so the worker
 * needs no session — it just has to be able to reach APP_URL.
 */

const WORKER_URL = () => process.env.WORKER_URL || "http://localhost:4020";
const SECRET = () => process.env.INTERNAL_API_SECRET || "dev-internal-secret-change-in-production";

export async function renderUrlToPdf(url: string): Promise<Buffer> {
  const res = await fetch(`${WORKER_URL()}/render-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": SECRET() },
    body: JSON.stringify({ url }),
    // Cold Chromium plus a full page render; generous but bounded.
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`PDF render failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
