import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./config";

/**
 * The parts that make it a Windows program a doctor can install by
 * double-clicking: it copies itself somewhere permanent, puts itself on the
 * Start menu and the desktop, starts with Windows, and opens its own window
 * (a page in the browser) — no administrator rights, no installer wizard.
 */

const isWindows = process.platform === "win32";
const APP = "Clinicti Bridge";

export function installDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Programs", APP);
}
export const installedExe = () => path.join(installDir(), "ClinictiBridge.exe");

function powershell(script: string, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    );
  });
}
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Copy the running .exe into the user's Programs folder, with shortcuts. Returns the installed path. */
export async function install(): Promise<string> {
  const target = installedExe();
  fs.mkdirSync(installDir(), { recursive: true });
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(target).toLowerCase()) {
    fs.copyFileSync(process.execPath, target);
  }
  if (isWindows) {
    /*
      Windows is asked where the desktop and Start menu are, rather than
      guessing %USERPROFILE%\Desktop — on many clinic computers OneDrive has
      moved the desktop, and a shortcut saved to the old place is never seen.
      CLINICTI_BRIDGE_SHORTCUTS_DIR puts both somewhere else, for testing.
    */
    const override = process.env.CLINICTI_BRIDGE_SHORTCUTS_DIR;
    const where = override
      ? `$menu = ${psQuote(override)}; $desk = ${psQuote(override)}`
      : `$menu = [Environment]::GetFolderPath('Programs'); $desk = [Environment]::GetFolderPath('Desktop')`;
    const shortcut = (dirVar: string) =>
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ${dirVar} ${psQuote(`${APP}.lnk`)})); $s.TargetPath = ${psQuote(target)}; $s.WorkingDirectory = ${psQuote(installDir())}; $s.Description = ${psQuote("Connects the clinic's x-ray and imaging machines to Clinicti")}; $s.Save()`;
    await powershell(`${where}; ${shortcut("$menu")}; ${shortcut("$desk")}`).catch((e) => log("shortcuts failed", e));
  }
  return target;
}

/** Start with Windows, in the background — the doctor never has to remember to open it. */
export async function setAutostart(on: boolean, exe: string) {
  if (!isWindows) return;
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const args = on ? ["add", key, "/v", APP, "/t", "REG_SZ", "/d", `"${exe}" --background`, "/f"] : ["delete", key, "/v", APP, "/f"];
  await new Promise<void>((resolve) => execFile("reg.exe", args, { windowsHide: true }, () => resolve()));
}

/** Run a copy of this program detached and hidden, so closing a window never stops it. */
export function runInBackground(exe: string, extra: string[]) {
  const child = spawn(exe, ["--background", ...extra], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export function openBrowser(url: string) {
  // Automated runs check the window over HTTP; they need no browser opened on the desktop.
  if (process.env.CLINICTI_BRIDGE_NO_BROWSER) return;
  if (isWindows) spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

/** Windows' own "choose a folder" dialog, on top of the browser. Null when cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!isWindows) return null;
  const out = await powershell(
    [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized'}",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description = 'Choose the folder your x-ray or imaging software saves pictures to'",
      "$d.ShowNewFolderButton = $false",
      "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ].join("; "),
    10 * 60_000
  ).catch(() => "");
  return out || null;
}

/**
 * Let machines on the network reach the DICOM port. Windows asks for
 * permission (one "Yes" on the administrator prompt); the rule is for this
 * program and this port only.
 */
export async function allowFirewall(port: number, exe: string): Promise<boolean> {
  if (!isWindows) return true;
  const cmd = `netsh advfirewall firewall delete rule name="${APP} DICOM" & netsh advfirewall firewall add rule name="${APP} DICOM" dir=in action=allow protocol=TCP localport=${port} program="${exe}" profile=private,domain`;
  try {
    await powershell(`Start-Process cmd.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList ${psQuote(`/c ${cmd}`)}`, 5 * 60_000);
    return true;
  } catch {
    return false;
  }
}

/** The addresses another machine on the clinic's network would use to reach this computer. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtualbox|vmware|loopback|wsl|hyper-v/i.test(name)) continue;
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
  }
  return out;
}

/**
 * A Windows notification on the imaging computer — "an x-ray is wanted" —
 * from a hidden PowerShell that shows it and goes away. Nothing to install.
 */
export function notify(title: string, text: string, iconFrom: string) {
  if (!isWindows || process.env.CLINICTI_BRIDGE_NO_BROWSER) return;
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    `try { $n.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon(${psQuote(iconFrom)}) } catch { $n.Icon = [System.Drawing.SystemIcons]::Information }`,
    `$n.BalloonTipTitle = ${psQuote(title.slice(0, 60))}`,
    `$n.BalloonTipText = ${psQuote(text.slice(0, 200))}`,
    "$n.Visible = $true",
    "$n.ShowBalloonTip(15000)",
    "Start-Sleep -Seconds 16",
    "$n.Dispose()",
  ].join("; ");
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

/**
 * A command line as words, the way Windows reads it: spaces separate,
 * double quotes keep a phrase (a path with spaces) together.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  for (const ch of line.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Run the clinic's "open the imaging software on this patient" command.
 *
 * The placeholders are filled inside each word of the command, and the
 * program is started directly — never through a shell — so a patient called
 * `Rana & del *.*` is a name, not an instruction. The first word must be a
 * program (.exe); Windows will not run a .bat this way, by design.
 */
export function runForRequest(template: string, values: Record<string, string>): { ok: boolean; error?: string } {
  const words = splitCommand(template);
  if (!words.length) return { ok: false, error: "empty" };
  const fill = (w: string) => w.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
  const [program, ...args] = words.map(fill);
  try {
    const child = spawn(program, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (e) => log("request command failed", e));
    child.unref();
    return { ok: true };
  } catch (e) {
    log("request command failed", e);
    return { ok: false, error: (e as Error).message };
  }
}
