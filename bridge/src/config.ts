import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Where the Bridge keeps itself, and what it remembers.
 *
 * One folder per Windows user (%LOCALAPPDATA%\Clinicti Bridge): the settings,
 * the images waiting to go up, the ones Clinicti refused, and a log. Nothing
 * here needs administrator rights — a doctor installs and runs it as
 * themselves.
 */

export type FolderWatch = {
  path: string;
  /** When it was added: files older than that were already there, and are not sent. */
  added: number;
};

export type Config = {
  server: string;
  /** The device key, collected at pairing. Null until paired, or after Clinicti revoked it. */
  key: string | null;
  device: { id: string; name: string; kind: string } | null;
  clinic: { name: string } | null;
  folders: FolderWatch[];
  dicom: { enabled: boolean; port: number; aet: string };
  uiPort: number;
  autostart: boolean;
};

export type Paths = {
  root: string;
  config: string;
  seen: string;
  outbox: string;
  incoming: string;
  failed: string;
  log: string;
};

export function pathsFor(root: string): Paths {
  const p = {
    root,
    config: path.join(root, "config.json"),
    seen: path.join(root, "seen.json"),
    outbox: path.join(root, "outbox"),
    incoming: path.join(root, "incoming"),
    failed: path.join(root, "failed"),
    log: path.join(root, "bridge.log"),
  };
  for (const d of [p.root, p.outbox, p.incoming, p.failed]) fs.mkdirSync(d, { recursive: true });
  return p;
}

export function defaultRoot(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Clinicti Bridge");
}

export function loadConfig(p: Paths, defaults: { server: string; uiPort: number }): Config {
  const fallback: Config = {
    server: defaults.server,
    key: null,
    device: null,
    clinic: null,
    folders: [],
    dicom: { enabled: true, port: 11112, aet: "CLINICTI" },
    uiPort: defaults.uiPort,
    autostart: true,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(p.config, "utf8")) as Partial<Config>;
    return { ...fallback, ...saved, dicom: { ...fallback.dicom, ...(saved.dicom ?? {}) } };
  } catch {
    return fallback;
  }
}

export function saveConfig(p: Paths, c: Config) {
  // Written aside and renamed, so a power cut mid-write cannot leave half a file.
  const tmp = `${p.config}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, p.config);
}

let logPath: string | null = null;
export function initLog(p: Paths) {
  logPath = p.log;
  try {
    if (fs.statSync(p.log).size > 5 * 1024 * 1024) fs.renameSync(p.log, `${p.log}.1`);
  } catch {
    // no log yet
  }
}
export function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} ${parts.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
  if (process.stdout.isTTY) process.stdout.write(line);
  if (logPath) {
    try {
      fs.appendFileSync(logPath, line);
    } catch {
      // the log is a convenience
    }
  }
}
