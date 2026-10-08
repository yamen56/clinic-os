import fs from "node:fs";
import os from "node:os";
import { deflateSync } from "node:zlib";
import { Api, type WorkItem } from "./api";
import { log, saveConfig, type Config, type Paths } from "./config";
import { Outbox } from "./outbox";
import { FolderWatcher } from "./folders";
import { startDicom, type DicomState } from "./dicom-server";
import { lanAddresses } from "./windows";

/**
 * The Bridge's working parts in one place: the queue, the folder watcher,
 * the DICOM node, and the heartbeat that tells Clinicti what it is doing.
 * The window (ui.ts) only ever reads `state()` and calls the methods here.
 */

const MODALITY: Record<string, string> = {
  xray: "IO",
  opg: "PX",
  cbct: "CT",
  camera: "XC",
  scanner: "OT",
  ultrasound: "US",
  other: "OT",
};

export class Bridge {
  api: Api;
  outbox: Outbox;
  folders: FolderWatcher;
  dicom: { state: DicomState; close: () => void } | null = null;
  private timers: NodeJS.Timeout[] = [];
  private beatSoon: NodeJS.Timeout | null = null;
  private worklistCache: { date: string | null; at: number; items: WorkItem[] } | null = null;
  lastBeat: { at: number; ok: boolean } | null = null;
  notice: string | null = null;

  constructor(
    public p: Paths,
    public cfg: Config,
    public version: string
  ) {
    this.api = new Api(cfg.server, cfg.key, version);
    this.outbox = new Outbox(
      p,
      (item, data) => this.api.upload(item, data),
      () => this.changed(),
      () => this.lostKey()
    );
    this.folders = new FolderWatcher(
      p,
      () => this.cfg.folders,
      (_file, name, data) => this.outbox.add(name, data, {}, "folder"),
      () => this.changed()
    );
  }

  get paired() {
    return !!this.cfg.key;
  }

  save() {
    saveConfig(this.p, this.cfg);
  }

  start() {
    this.timers.push(setInterval(() => void this.outbox.pump(!this.paired), 1000));
    this.timers.push(setInterval(() => this.paired && this.folders.look(), 3000));
    this.timers.push(setInterval(() => void this.heartbeat(), 30_000));
    this.restartDicom();
    void this.heartbeat();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.dicom?.close();
  }

  /** Something changed: tell Clinicti within a couple of seconds, not at the next half-minute. */
  changed() {
    if (this.beatSoon) return;
    this.beatSoon = setTimeout(() => {
      this.beatSoon = null;
      void this.heartbeat();
    }, 2000);
  }

  restartDicom() {
    this.dicom?.close();
    this.dicom = null;
    if (!this.paired || !this.cfg.dicom.enabled) return;
    this.dicom = startDicom({
      port: this.cfg.dicom.port,
      aet: this.cfg.dicom.aet,
      incomingDir: this.p.incoming,
      modality: () => MODALITY[this.cfg.device?.kind ?? "other"] ?? "OT",
      onStore: (file, name) => this.outbox.adopt(name, file, {}, "dicom"),
      worklist: (date) => this.worklist(date),
      onChange: () => this.changed(),
    });
  }

  /** Cached for twenty seconds: a machine may ask every few seconds while someone scrolls its list. */
  private async worklist(date: string | null) {
    const c = this.worklistCache;
    if (c && c.date === date && Date.now() - c.at < 20_000) return c.items;
    const items = await this.api.worklist(date ?? undefined);
    this.worklistCache = { date, at: Date.now(), items };
    return items;
  }

  async pair(code: string) {
    const r = await this.api.pair(code, os.hostname());
    if (!r.ok) return r;
    this.cfg.key = r.key;
    this.cfg.device = { id: r.device.id, name: r.device.name, kind: r.device.kind };
    this.cfg.clinic = { name: r.clinic.name };
    this.api.key = r.key;
    this.notice = null;
    this.save();
    log("paired as", r.device.name, "for", r.clinic.name);
    this.restartDicom();
    void this.heartbeat();
    return r;
  }

  /** Clinicti no longer knows this key (revoked, or paired again elsewhere): stop, keep the queue, ask to pair. */
  private lostKey() {
    log("key refused: needs pairing again");
    this.cfg.key = null;
    this.api.key = null;
    this.notice = "key_revoked";
    this.save();
    this.restartDicom();
    this.changed();
  }

  unpair() {
    this.cfg.key = null;
    this.cfg.device = null;
    this.cfg.clinic = null;
    this.api.key = null;
    this.save();
    this.restartDicom();
  }

  addFolder(dir: string) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false as const, error: "folder_missing" };
    if (this.cfg.folders.some((f) => f.path.toLowerCase() === dir.toLowerCase())) return { ok: true as const };
    this.folders.baseline(dir);
    this.cfg.folders.push({ path: dir, added: Date.now() });
    this.save();
    this.folders.look();
    this.changed();
    return { ok: true as const };
  }

  removeFolder(dir: string) {
    this.cfg.folders = this.cfg.folders.filter((f) => f.path !== dir);
    this.save();
    this.folders.look();
    this.changed();
  }

  setDicom(next: { enabled?: boolean; port?: number; aet?: string }) {
    const port = Number(next.port ?? this.cfg.dicom.port);
    const aet = String(next.aet ?? this.cfg.dicom.aet).toUpperCase().replace(/[^A-Z0-9_ -]/g, "").slice(0, 16) || "CLINICTI";
    this.cfg.dicom = {
      enabled: next.enabled ?? this.cfg.dicom.enabled,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : this.cfg.dicom.port,
      aet,
    };
    this.save();
    this.restartDicom();
    this.changed();
  }

  sendTest() {
    this.outbox.add("Clinicti Bridge test.png", testPicture(), {}, "test");
  }

  /** What the Bridge tells Clinicti about itself — and what Settings → Devices shows. */
  report() {
    return {
      version: this.version,
      host: os.hostname(),
      lan: lanAddresses(),
      folders: this.folders.states,
      dicom: {
        enabled: this.cfg.dicom.enabled,
        port: this.cfg.dicom.port,
        aet: this.cfg.dicom.aet,
        listening: !!this.dicom?.state.listening,
        error: this.dicom?.state.error ?? null,
        lastEcho: this.dicom?.state.lastEcho?.at ?? null,
        lastEchoFrom: this.dicom?.state.lastEcho?.from ?? null,
        lastStore: this.dicom?.state.lastStore?.at ?? null,
        lastFind: this.dicom?.state.lastFind?.at ?? null,
      },
      queued: this.outbox.list().length,
      failed: this.outbox.list("failed").length,
      lastUpload: this.outbox.recent[0] ? { at: this.outbox.recent[0].at, name: this.outbox.recent[0].name, placed: this.outbox.recent[0].placed } : null,
      lastError: this.outbox.lastError,
    };
  }

  async heartbeat() {
    if (!this.paired) return;
    try {
      const r = await this.api.status(this.report());
      this.lastBeat = { at: Date.now(), ok: r.status === 200 };
      if (r.status === 401) return this.lostKey();
      // The clinic may have renamed the device in Clinicti.
      if (r.device && this.cfg.device && (r.device.name !== this.cfg.device.name || r.device.kind !== this.cfg.device.kind)) {
        this.cfg.device = { ...this.cfg.device, name: r.device.name, kind: r.device.kind };
        this.save();
      }
    } catch (e) {
      this.lastBeat = { at: Date.now(), ok: false };
      log("heartbeat failed", e);
    }
  }

  state() {
    return {
      paired: this.paired,
      notice: this.notice,
      server: this.cfg.server,
      clinic: this.cfg.clinic,
      device: this.cfg.device,
      online: this.lastBeat?.ok ?? null,
      autostart: this.cfg.autostart,
      ...this.report(),
      recent: this.outbox.recent.slice(0, 12),
      failedItems: this.outbox.list("failed").slice(-12).map((i) => ({ name: i.name, error: i.lastError })),
    };
  }
}

/** A small picture for "Send a test": a soft gradient, so it is plainly not an x-ray in the inbox. */
function testPicture(): Buffer {
  const w = 160;
  const h = 100;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 11 + Math.round((x / w) * 60);
      raw[o + 1] = 18 + Math.round((y / h) * 90);
      raw[o + 2] = 32 + Math.round(((x + y) / (w + h)) * 150);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
