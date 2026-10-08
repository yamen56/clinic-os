import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { log, type Paths } from "./config";

/**
 * Everything the Bridge receives is written here before it is sent, and only
 * removed once Clinicti has it. A clinic's internet drops; a power cut takes
 * the computer down mid-upload; neither loses an x-ray. What Clinicti refuses
 * outright (not an image it can keep, a patient that does not exist) moves to
 * `failed`, where the doctor can see it and send it again.
 */

export type Item = {
  id: string;
  name: string;
  /** Extra form fields for /images: patient, teeth, kind, requestId. */
  fields: Record<string, string>;
  source: "folder" | "dicom" | "test";
  received: number;
  attempts: number;
  nextAt: number;
  lastError?: string;
};

export type Sent = { at: number; name: string; placed: string; patient?: string | null };

export type UploadResult =
  | { ok: true; placed: string; patientId?: string | null }
  | { ok: false; retry: boolean; unpaired?: boolean; error: string };

export class Outbox {
  recent: Sent[] = [];
  lastError: string | null = null;
  private busy = false;

  constructor(
    private p: Paths,
    private upload: (item: Item, data: Buffer) => Promise<UploadResult>,
    private onChange: () => void,
    private onUnpaired: () => void
  ) {}

  /** Keep a copy and queue it. Returns once the bytes are safely on disk. */
  add(name: string, data: Buffer, fields: Record<string, string>, source: Item["source"]): Item {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const item: Item = { id, name, fields, source, received: Date.now(), attempts: 0, nextAt: 0 };
    fs.writeFileSync(path.join(this.p.outbox, `${id}.bin`), data);
    fs.writeFileSync(path.join(this.p.outbox, `${id}.json`), JSON.stringify(item));
    this.onChange();
    return item;
  }

  /** Move a file already on disk (a received DICOM) into the queue without copying it. */
  adopt(name: string, file: string, fields: Record<string, string>, source: Item["source"]): Item {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const item: Item = { id, name, fields, source, received: Date.now(), attempts: 0, nextAt: 0 };
    fs.renameSync(file, path.join(this.p.outbox, `${id}.bin`));
    fs.writeFileSync(path.join(this.p.outbox, `${id}.json`), JSON.stringify(item));
    this.onChange();
    return item;
  }

  list(dir: "outbox" | "failed" = "outbox"): Item[] {
    const folder = dir === "outbox" ? this.p.outbox : this.p.failed;
    const out: Item[] = [];
    for (const f of fs.readdirSync(folder)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(folder, f), "utf8")));
      } catch {
        // half-written: the next look will see it whole
      }
    }
    return out.sort((a, b) => a.received - b.received);
  }

  retryFailed() {
    for (const item of this.list("failed")) {
      for (const ext of ["bin", "json"]) {
        try {
          fs.renameSync(path.join(this.p.failed, `${item.id}.${ext}`), path.join(this.p.outbox, `${item.id}.${ext}`));
        } catch {
          // gone already
        }
      }
      this.write({ ...item, attempts: 0, nextAt: 0, lastError: undefined });
    }
    this.onChange();
  }

  private write(item: Item) {
    fs.writeFileSync(path.join(this.p.outbox, `${item.id}.json`), JSON.stringify(item));
  }

  /** Send what is due, oldest first, one at a time. Called on a timer. */
  async pump(paused: boolean) {
    if (this.busy || paused) return;
    this.busy = true;
    try {
      for (const item of this.list()) {
        if (item.nextAt > Date.now()) continue;
        const bin = path.join(this.p.outbox, `${item.id}.bin`);
        let data: Buffer;
        try {
          data = fs.readFileSync(bin);
        } catch {
          fs.rmSync(path.join(this.p.outbox, `${item.id}.json`), { force: true });
          continue;
        }
        const r = await this.upload(item, data).catch(
          (e: Error): UploadResult => ({ ok: false, retry: true, error: e.message || "network" })
        );
        if (r.ok) {
          fs.rmSync(bin, { force: true });
          fs.rmSync(path.join(this.p.outbox, `${item.id}.json`), { force: true });
          this.recent = [{ at: Date.now(), name: item.name, placed: r.placed, patient: r.patientId }, ...this.recent].slice(0, 30);
          this.lastError = null;
          log("sent", item.name, r.placed);
        } else if (r.unpaired) {
          this.lastError = r.error;
          this.onUnpaired();
          break;
        } else if (r.retry) {
          // 2 s, 4 s, 8 s … up to 5 minutes: patient while the line is down, quick once it is back.
          const attempts = item.attempts + 1;
          this.write({ ...item, attempts, nextAt: Date.now() + Math.min(300_000, 2000 * 2 ** Math.min(attempts, 8)), lastError: r.error });
          this.lastError = r.error;
          log("will retry", item.name, r.error);
          break;
        } else {
          for (const ext of ["bin", "json"]) {
            fs.renameSync(path.join(this.p.outbox, `${item.id}.${ext}`), path.join(this.p.failed, `${item.id}.${ext}`));
          }
          fs.writeFileSync(path.join(this.p.failed, `${item.id}.json`), JSON.stringify({ ...item, lastError: r.error }));
          this.lastError = r.error;
          log("refused", item.name, r.error);
        }
        this.onChange();
      }
    } finally {
      this.busy = false;
    }
  }
}
