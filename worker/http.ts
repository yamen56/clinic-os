import http from "node:http";
import { withSystem } from "./db";
import { ensureSession, stopSession, sessions } from "./wa/session";
import { recordMessage } from "./wa/inbound";
import { renderUrlToPdf, renderPageOverlays } from "./pdf";
import { normalizePhone } from "../src/lib/phone";
import { internalSecretIsWeak, internalSecretMatches } from "../src/lib/internal-secret";

// Read lazily: never capture config at module-load time.
const port = () => Number(new URL(process.env.WORKER_URL || "http://localhost:4020").port || 4020);

/**
 * The only place this process will point a browser at.
 *
 * `/render-pdf` hands an arbitrary URL to Chromium, which is a request-forgery
 * primitive by construction: the worker sits inside the private network, so a
 * caller who reaches this endpoint can read anything the worker can — the
 * platform metadata service, an internal admin port, a database console — and
 * gets the answer back rendered as a PDF.
 *
 * The secret is the door, and it should hold. This is the second lock, for the
 * case where it does not: the only pages that ever need rendering are our own
 * invoice and document print pages, so nothing else is a legitimate target and
 * refusing everything else costs the feature nothing.
 */
function isRenderableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const app = process.env.APP_URL;
  if (!app) {
    // Nothing configured to compare against — allow only loopback, which is
    // what a local development run actually uses.
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  }
  try {
    return u.origin === new URL(app).origin;
  } catch {
    return false;
  }
}

/** Internal control API for the web app (shared-secret protected). */
export function startHttpServer() {
  const server = http.createServer((req, res) => {
    void (async () => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        if (!internalSecretMatches(req.headers["x-internal-secret"])) {
          return send(401, { error: "unauthorized" });
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean);

        // POST /sessions/:clinicId/connect | /disconnect
        if (req.method === "POST" && parts[0] === "sessions" && parts.length === 3) {
          const clinicId = parts[1];
          if (parts[2] === "connect") {
            await withSystem((c) =>
              c.query(
                `insert into whatsapp_sessions (clinic_id, desired, status)
                 values ($1, true, 'connecting')
                 on conflict (clinic_id) do update set desired = true, status = 'connecting', error = null`,
                [clinicId]
              )
            );
            await stopSession(clinicId);
            await ensureSession(clinicId);
            return send(200, { ok: true });
          }
          if (parts[2] === "disconnect") {
            await stopSession(clinicId, { logout: true });
            return send(200, { ok: true });
          }
        }

        // GET /health — session overview for admin monitoring
        if (req.method === "GET" && parts[0] === "health") {
          return send(200, {
            ok: true,
            sessions: [...sessions.entries()].map(([id, s]) => ({
              clinicId: id,
              connected: s.connected,
            })),
            uptime: process.uptime(),
          });
        }

        // POST /render-pdf — the web app has no Chromium; this process does
        if (req.method === "POST" && parts[0] === "render-pdf") {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const { url } = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          if (typeof url !== "string" || !isRenderableUrl(url)) {
            return send(400, { error: "bad_url" });
          }
          const pdf = await renderUrlToPdf(url);
          res.writeHead(200, {
            "Content-Type": "application/pdf",
            "Content-Length": String(pdf.length),
          });
          return res.end(pdf);
        }

        // POST /render-overlays — transparent per-page layers for uploaded PDFs
        if (req.method === "POST" && parts[0] === "render-overlays") {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const { url } = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          if (typeof url !== "string" || !isRenderableUrl(url)) {
            return send(400, { error: "bad_url" });
          }
          return send(200, { pages: await renderPageOverlays(url) });
        }

        // POST /simulate-inbound — dev/testing only: exercises the threading pipeline
        if (
          req.method === "POST" &&
          parts[0] === "simulate-inbound" &&
          process.env.NODE_ENV !== "production"
        ) {
          const chunks: Buffer[] = [];
          for await (const ch of req) chunks.push(ch as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
          const phone = normalizePhone(String(body.phone ?? ""));
          if (!phone || !body.clinicId) return send(400, { error: "bad_request" });
          await recordMessage(body.clinicId, {
            phone,
            fromMe: false,
            waId: `SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            msgType: "text",
            body: String(body.body ?? ""),
            mediaPath: null,
            mediaMime: null,
            mediaName: null,
            pushName: body.name ?? null,
          });
          return send(200, { ok: true });
        }

        send(404, { error: "not_found" });
      } catch (e) {
        send(500, { error: (e as Error).message });
      }
    })();
  });
  const p = port();
  server.listen(p, () => {
    console.log(`[worker] internal API on :${p}`);
    /*
      Said once, loudly, at boot. This port is published on a public domain, so
      a placeholder secret here is not a development inconvenience — it is
      anybody being able to disconnect a clinic’s WhatsApp number. In
      production `internalSecretMatches` already refuses every request rather
      than accept the placeholder; this is so the reason is visible in the logs
      instead of appearing as a worker nothing can talk to.
    */
    if (internalSecretIsWeak()) {
      const msg =
        "[worker] INTERNAL_API_SECRET is unset, too short, or the development placeholder";
      if (process.env.NODE_ENV === "production") {
        console.error(`${msg} — the control API will refuse every request until it is set.`);
      } else {
        console.warn(`${msg} (fine locally; must be set in production).`);
      }
    }
  });
}
