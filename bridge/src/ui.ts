import http from "node:http";
import { log } from "./config";
import type { Bridge } from "./bridge";
import { allowFirewall, installedExe, pickFolder, setAutostart } from "./windows";
import { PAGE } from "./ui-page";

/**
 * The Bridge's window: a page in the computer's own browser, served only to
 * this computer (127.0.0.1). Three things keep another website from driving
 * it — which matters, because "pair with this code" would otherwise let a
 * malicious page send a clinic's x-rays somewhere else:
 *   - it listens on loopback only;
 *   - the Host header must be this address (no DNS-rebinding);
 *   - every change needs an `x-bridge-ui` header, which a cross-site request
 *     cannot send without a CORS preflight this server never approves.
 */

export function startUi(bridge: Bridge, port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
        "x-frame-options": "DENY",
      });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") return json(200, bridge.state());

    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) return json(404, { error: "not_found" });
    if (req.headers["x-bridge-ui"] !== "1") return json(403, { error: "forbidden" });

    let body: Record<string, unknown> = {};
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      return json(400, { error: "invalid" });
    }

    try {
      switch (url.pathname) {
        case "/api/pair": {
          const r = await bridge.pair(String(body.code ?? ""));
          return r.ok ? json(200, { ok: true }) : json(400, { error: r.error });
        }
        case "/api/unpair":
          bridge.unpair();
          return json(200, { ok: true });
        case "/api/folders/pick": {
          const dir = await pickFolder();
          if (!dir) return json(200, { ok: false, cancelled: true });
          return json(200, bridge.addFolder(dir));
        }
        case "/api/folders/add":
          return json(200, bridge.addFolder(String(body.path ?? "").trim()));
        case "/api/folders/remove":
          bridge.removeFolder(String(body.path ?? ""));
          return json(200, { ok: true });
        case "/api/dicom":
          bridge.setDicom({
            enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
            port: body.port !== undefined ? Number(body.port) : undefined,
            aet: body.aet !== undefined ? String(body.aet) : undefined,
          });
          return json(200, { ok: true });
        case "/api/firewall":
          return json(200, { ok: await allowFirewall(bridge.cfg.dicom.port, process.execPath) });
        case "/api/test":
          bridge.sendTest();
          return json(200, { ok: true });
        case "/api/retry":
          bridge.outbox.retryFailed();
          return json(200, { ok: true });
        case "/api/quit":
          // A newer copy being installed asks the running one to make way.
          json(200, { ok: true });
          setTimeout(() => {
            bridge.stop();
            process.exit(0);
          }, 150);
          return;
        case "/api/autostart":
          bridge.cfg.autostart = !!body.on;
          bridge.save();
          await setAutostart(bridge.cfg.autostart, installedExe());
          return json(200, { ok: true });
        default:
          return json(404, { error: "not_found" });
      }
    } catch (e) {
      log("ui error", url.pathname, e);
      return json(500, { error: (e as Error).message || "failed" });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
