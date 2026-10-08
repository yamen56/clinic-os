import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import * as dimse from "dcmjs-dimse";
import { log } from "./config";
import type { WorkItem } from "./api";

/**
 * The Bridge as a DICOM node on the clinic's network.
 *
 * An OPG, a CBCT or a digital x-ray is told "send to this address, this port,
 * this AE title" in its own settings — the one step that happens on the
 * machine — and from then on it sends here like it would to any PACS:
 *
 *   C-ECHO   the machine's "Test"/"Verify" button. Answered, and remembered,
 *            so the setup screen in Clinicti can tick "the machine can see
 *            the Bridge".
 *   C-STORE  an image. Kept exactly as the machine sent it — the dataset
 *            bytes go straight to disk and get a standard file header, never
 *            decoded and re-encoded — so any machine, any compression, any
 *            vendor's private tags arrive intact.
 *   C-FIND   (Modality Worklist) the machine asking who is booked. Answered
 *            with today's patients and anyone a doctor is waiting on, each
 *            with Patient ID "CLN-<file number>": pick the patient on the
 *            machine, and every image comes back already knowing whose it is.
 */

const { Dataset, Server, Scp } = dimse;
const { CEchoResponse, CFindResponse, CStoreResponse } = dimse.responses;
const { Status, PresentationContextResult, SopClass, TransferSyntax } = dimse.constants;

dimse.log.setLevel("error");

export type DicomState = {
  listening: boolean;
  error: string | null;
  lastEcho: { at: number; from: string } | null;
  lastStore: { at: number; from: string; sop: string } | null;
  lastFind: { at: number; from: string; results: number } | null;
};

export type DicomOptions = {
  port: number;
  aet: string;
  incomingDir: string;
  /** Modality to put on a worklist line when the machine does not say. */
  modality: () => string;
  onStore: (file: string, name: string) => void;
  worklist: (date: string | null) => Promise<WorkItem[]>;
  onChange: () => void;
};

/** Storage classes are 1.2.840.10008.5.1.4.1.1.*; a vendor's private one is outside 1.2.840.10008 entirely. */
function isStorage(uid: string) {
  return uid.startsWith("1.2.840.10008.5.1.4.1.1.") || !uid.startsWith("1.2.840.10008.");
}

// ── Part 10 file header ──────────────────────────────────────────────
function el(group: number, element: number, vr: string, value: Buffer): Buffer {
  const long = vr === "OB";
  const head = Buffer.alloc(long ? 12 : 8);
  head.writeUInt16LE(group, 0);
  head.writeUInt16LE(element, 2);
  head.write(vr, 4, "latin1");
  if (long) head.writeUInt32LE(value.length, 8);
  else head.writeUInt16LE(value.length, 6);
  return Buffer.concat([head, value]);
}
const ui = (s: string) => Buffer.from(s.length % 2 ? `${s}\0` : s, "latin1");
const sh = (s: string) => Buffer.from(s.length % 2 ? `${s} ` : s, "latin1");

/** The 128-byte preamble, "DICM", and group 0002 — explicit VR little endian, as the standard requires. */
export function part10Header(sopClass: string, sopInstance: string, transferSyntax: string, sourceAe: string): Buffer {
  const body = Buffer.concat([
    el(0x0002, 0x0001, "OB", Buffer.from([0, 1])),
    el(0x0002, 0x0002, "UI", ui(sopClass)),
    el(0x0002, 0x0003, "UI", ui(sopInstance)),
    el(0x0002, 0x0010, "UI", ui(transferSyntax)),
    el(0x0002, 0x0012, "UI", ui("1.2.826.0.1.3680043.10.1351.1")),
    el(0x0002, 0x0013, "SH", sh("CLINICTI_BRIDGE")),
    ...(sourceAe ? [el(0x0002, 0x0016, "AE", sh(sourceAe.slice(0, 16)))] : []),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.alloc(128), Buffer.from("DICM", "latin1"), el(0x0002, 0x0000, "UL", len), body]);
}

// ── Worklist answers ─────────────────────────────────────────────────
/** "Rana Ahmad Haddad" → "Haddad^Rana^Ahmad": family^given^middle, how DICOM writes a name. */
export function personName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return full.trim();
  return [parts[parts.length - 1], parts[0], parts.slice(1, -1).join(" ")].filter(Boolean).join("^");
}

function uidFrom(id: string): string {
  const hex = id.replace(/-/g, "");
  return /^[0-9a-f]{32}$/i.test(hex) ? `2.25.${BigInt(`0x${hex}`).toString(10)}` : Dataset.generateDerivedUid();
}

/** DICOM wildcard match: * any run, ? one character, case-insensitive. Empty matches all. */
function wildcard(pattern: unknown, value: string): boolean {
  const p = typeof pattern === "string" ? pattern.trim() : "";
  if (!p || p === "*") return true;
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(value) || re.test(value.replace(/\^/g, " "));
}

function localParts(iso: string | null): { date: string; time: string } {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`, time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` };
}

/** The day a worklist query asks about: one date, the start of a range, or today. */
function queryDate(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function startDicom(opts: DicomOptions): { state: DicomState; close: () => void } {
  const state: DicomState = { listening: false, error: null, lastEcho: null, lastStore: null, lastFind: null };

  class BridgeScp extends Scp {
    private from = "";

    associationRequested(association: dimse.association.Association) {
      this.from = association.getCallingAeTitle();
      for (const c of association.getPresentationContexts()) {
        const ctx = association.getPresentationContext(c.id);
        const as = ctx.getAbstractSyntaxUid();
        const offered = ctx.getTransferSyntaxUids();
        if (as === SopClass.Verification || as === SopClass.ModalityWorklistInformationModelFind) {
          const ts = offered.find((t) => t === TransferSyntax.ExplicitVRLittleEndian) ?? offered.find((t) => t === TransferSyntax.ImplicitVRLittleEndian);
          if (ts) ctx.setResult(PresentationContextResult.Accept, ts);
          else ctx.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
        } else if (isStorage(as)) {
          // Whatever the machine compressed it with: the bytes are kept, never decoded here.
          const ts = offered.find((t) => t === TransferSyntax.ExplicitVRLittleEndian) ?? offered[0];
          if (ts) ctx.setResult(PresentationContextResult.Accept, ts);
          else ctx.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
        } else {
          ctx.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
        }
      }
      this.sendAssociationAccept();
    }

    associationReleaseRequested() {
      this.sendAssociationReleaseResponse();
    }

    cEchoRequest(request: dimse.requests.CEchoRequest, callback: (r: dimse.responses.CEchoResponse) => void) {
      state.lastEcho = { at: Date.now(), from: this.from };
      log("echo from", this.from);
      opts.onChange();
      const response = CEchoResponse.fromRequest(request);
      response.setStatus(Status.Success);
      callback(response);
    }

    createStoreWritableStream(): Writable {
      const file = path.join(opts.incomingDir, `${Date.now()}-${randomUUID().slice(0, 8)}.part`);
      const ws = fs.createWriteStream(file);
      (ws as unknown as { file: string }).file = file;
      return ws;
    }

    createDatasetFromStoreWritableStream(
      writable: Writable,
      ctx: dimse.association.PresentationContext,
      callback: (dataset: dimse.Dataset) => void
    ) {
      // The library ends the stream and asks at once; the file is whole only on "finish".
      const done = () => {
        const ds = new Dataset({}, ctx.getAcceptedTransferSyntaxUid());
        Object.assign(ds, { file: (writable as unknown as { file: string }).file, ts: ctx.getAcceptedTransferSyntaxUid() });
        callback(ds);
      };
      if ((writable as unknown as { writableFinished: boolean }).writableFinished) done();
      else writable.once("finish", done);
    }

    cStoreRequest(request: dimse.requests.CStoreRequest, callback: (r: dimse.responses.CStoreResponse) => void) {
      const response = CStoreResponse.fromRequest(request);
      const ds = request.getDataset() as unknown as { file?: string; ts?: string } | undefined;
      try {
        if (!ds?.file || !ds.ts) throw new Error("no_dataset");
        const sop = request.getAffectedSopInstanceUid();
        const out = ds.file.replace(/\.part$/, ".dcm");
        const fd = fs.openSync(out, "w");
        try {
          fs.writeSync(fd, part10Header(request.getAffectedSopClassUid(), sop, ds.ts, this.from));
          const src = fs.openSync(ds.file, "r");
          const chunk = Buffer.alloc(1024 * 1024);
          for (let n; (n = fs.readSync(src, chunk, 0, chunk.length, null)) > 0; ) fs.writeSync(fd, chunk, 0, n);
          fs.closeSync(src);
        } finally {
          fs.closeSync(fd);
        }
        fs.rmSync(ds.file, { force: true });
        // A name a person can read in the Bridge's list; whose it is and what it shows travel inside the file.
        const at = new Date();
        const hhmm = `${String(at.getHours()).padStart(2, "0")}.${String(at.getMinutes()).padStart(2, "0")}`;
        opts.onStore(out, `Image from ${(this.from || "the machine").replace(/[^\w .-]/g, "")} ${hhmm}.dcm`);
        state.lastStore = { at: Date.now(), from: this.from, sop };
        opts.onChange();
        response.setStatus(Status.Success);
      } catch (e) {
        log("store failed", e);
        if (ds?.file) fs.rmSync(ds.file, { force: true });
        response.setStatus(Status.ProcessingFailure);
      }
      callback(response);
    }

    cFindRequest(request: dimse.requests.CFindRequest, callback: (r: dimse.responses.CFindResponse[]) => void) {
      const finish = (pending: dimse.responses.CFindResponse[], status: number) => {
        const last = CFindResponse.fromRequest(request);
        last.setStatus(status);
        callback([...pending, last]);
      };
      if (request.getAffectedSopClassUid() !== SopClass.ModalityWorklistInformationModelFind) return finish([], Status.Success);
      const q = (request.getDataset()?.getElements() ?? {}) as Record<string, unknown>;
      const sps = ((q.ScheduledProcedureStepSequence as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
      const modality = typeof sps.Modality === "string" && sps.Modality.trim() ? sps.Modality.trim() : opts.modality();
      const station = typeof sps.ScheduledStationAETitle === "string" && sps.ScheduledStationAETitle.trim() ? sps.ScheduledStationAETitle.trim() : this.from;
      opts
        .worklist(queryDate(sps.ScheduledProcedureStepStartDate))
        .then((items) => {
          const pending: dimse.responses.CFindResponse[] = [];
          for (const it of items) {
            const pid = it.patient.fileNo != null ? `CLN-${it.patient.fileNo}` : it.patient.id;
            const name = personName(it.patient.name);
            if (!wildcard(q.PatientName, name) || !wildcard(q.PatientID, pid)) continue;
            const when = localParts(it.startsAt);
            const acc = it.id.replace(/-/g, "").slice(0, 16).toUpperCase();
            const r = CFindResponse.fromRequest(request);
            r.setDataset(
              new Dataset({
                SpecificCharacterSet: "ISO_IR 192",
                PatientName: name,
                PatientID: pid,
                PatientBirthDate: it.patient.birthDate ? it.patient.birthDate.replace(/-/g, "") : "",
                PatientSex: it.patient.sex ?? "O",
                AccessionNumber: acc,
                ReferringPhysicianName: it.doctor ?? "",
                StudyInstanceUID: uidFrom(it.id),
                RequestedProcedureID: acc,
                RequestedProcedureDescription: it.description,
                ScheduledProcedureStepSequence: [
                  {
                    Modality: modality,
                    ScheduledStationAETitle: station,
                    ScheduledProcedureStepStartDate: when.date,
                    ScheduledProcedureStepStartTime: when.time,
                    ScheduledPerformingPhysicianName: it.doctor ?? "",
                    ScheduledProcedureStepDescription: it.description,
                    ScheduledProcedureStepID: acc,
                  },
                ],
              })
            );
            r.setStatus(Status.Pending);
            pending.push(r);
          }
          state.lastFind = { at: Date.now(), from: this.from, results: pending.length };
          opts.onChange();
          finish(pending, Status.Success);
        })
        .catch((e) => {
          log("worklist failed", e);
          finish([], Status.ProcessingFailure);
        });
    }
  }

  const server = new Server(BridgeScp);
  server.on("networkError", (e: Error) => {
    log("dicom network error", e);
    state.error = (e as NodeJS.ErrnoException).code === "EADDRINUSE" ? "port_in_use" : e.message;
    state.listening = state.error === "port_in_use" ? false : state.listening;
    opts.onChange();
  });
  try {
    server.listen(opts.port);
    state.listening = true;
    log("dicom listening on", opts.port, "as", opts.aet);
  } catch (e) {
    state.error = (e as Error).message;
  }
  return {
    state,
    close: () => {
      try {
        server.close();
      } catch {
        // already closed
      }
    },
  };
}
