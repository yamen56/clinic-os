import http from "node:http";
import path from "node:path";
import { BRIDGE_VERSION } from "../../src/lib/imaging/bridge-version";
import { defaultRoot, initLog, loadConfig, log, pathsFor } from "./config";
import { Bridge } from "./bridge";
import { startUi } from "./ui";
import { install, installedExe, openBrowser, runInBackground, setAutostart } from "./windows";

/**
 * Clinicti Bridge.
 *
 * Double-clicked, it installs itself for this Windows user (no administrator
 * needed), starts in the background, sets itself to start with Windows, and
 * opens its window in the browser. Double-clicked again, it just opens the
 * window. A newer download double-clicked replaces the running copy.
 *
 *   --background   run the Bridge (how Windows starts it)
 *   --foreground   run it in this console, for development and QA
 *   --server URL   which Clinicti (default: the live one)
 *   --data DIR     where it keeps itself (default: %LOCALAPPDATA%\Clinicti Bridge)
 *   --ui-port N    the window's port (default 8790)
 */

declare const __CLINICTI_SERVER__: string | undefined;
const LIVE = typeof __CLINICTI_SERVER__ === "string" ? __CLINICTI_SERVER__ : "https://app.clinicti.app";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const passOn = ["--server", "--data", "--ui-port"].flatMap((n) => (opt(n) ? [n, opt(n)!] : []));

const p = pathsFor(opt("--data") ?? defaultRoot());
initLog(p);
const cfg = loadConfig(p, { server: opt("--server") ?? LIVE, uiPort: Number(opt("--ui-port") ?? 8790) });
if (opt("--server")) cfg.server = opt("--server")!;
if (opt("--ui-port")) cfg.uiPort = Number(opt("--ui-port"));
const uiUrl = `http://127.0.0.1:${cfg.uiPort}/`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
  The launcher talks to a running Bridge with plain http and no keep-alive.
  With fetch, the pooled sockets are still closing when the launcher exits,
  and Node on Windows can abort on exactly that (libuv's "handle closing"
  assertion) — a console window flashing an error at the doctor for nothing.
*/
function local(method: "GET" | "POST", p: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: cfg.uiPort, path: p, method, agent: false, timeout: 1500, headers: method === "POST" ? { "x-bridge-ui": "1", "content-type": "application/json", "content-length": 2 } : {} },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
    req.end(method === "POST" ? "{}" : undefined);
  });
}
const running = async () => (await local("GET", "/api/state")) === 200;

async function isSea(): Promise<boolean> {
  try {
    const sea = (await import("node:sea")) as { isSea?: () => boolean };
    return !!sea.isSea?.();
  } catch {
    return false;
  }
}

async function serve() {
  const bridge = new Bridge(p, cfg, BRIDGE_VERSION);
  try {
    await startUi(bridge, cfg.uiPort);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      log("already running");
      process.exit(0);
    }
    throw e;
  }
  bridge.save();
  bridge.start();
  log(`Clinicti Bridge ${BRIDGE_VERSION} running for ${cfg.server}; window at ${uiUrl}`);
  const quit = () => {
    bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

async function main() {
  if (flag("--foreground") || flag("--background")) return serve();

  // Double-clicked.
  const packaged = await isSea();
  if (!packaged) {
    // Running from source: no installing, just run here and open the window.
    if (!(await running())) await serve();
    openBrowser(uiUrl);
    return;
  }

  let exe = process.execPath;
  if (process.platform === "win32" && path.resolve(exe).toLowerCase() !== installedExe().toLowerCase()) {
    // A copy from Downloads: the running one (an older version) makes way, then this one installs.
    if (await running()) {
      await local("POST", "/api/quit");
      for (let i = 0; i < 20 && (await running()); i++) await sleep(250);
      await sleep(500);
    }
    exe = await install();
  }
  if (cfg.autostart) await setAutostart(true, exe);
  if (!(await running())) runInBackground(exe, passOn);
  for (let i = 0; i < 60 && !(await running()); i++) await sleep(250);
  openBrowser(uiUrl);
  // Nothing left open: the launcher ends by itself, without process.exit's abrupt teardown.
}

main().catch((e) => {
  log("fatal", e);
  process.exit(1);
});
