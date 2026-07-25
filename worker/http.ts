import http from "node:http";
import { withSystem } from "./db";
import { ensureSession, stopSession, sessions } from "./wa/session";
import { recordMessage } from "./wa/inbound";
import { normalizePhone } from "../src/lib/phone";

const SECRET = process.env.INTERNAL_API_SECRET || "dev-internal-secret-change-in-production";
const PORT = Number(new URL(process.env.WORKER_URL || "http://localhost:4020").port || 4020);

/** Internal control API for the web app (shared-secret protected). */
export function startHttpServer() {
  const server = http.createServer((req, res) => {
    void (async () => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.headers["x-internal-secret"] !== SECRET) return send(401, { error: "unauthorized" });
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
  server.listen(PORT, () => console.log(`[worker] internal API on :${PORT}`));
}
