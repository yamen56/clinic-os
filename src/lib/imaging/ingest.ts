import type { PoolClient } from "pg";
import { saveFile, deleteFiles } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/uuid";
import { nationalIdOf } from "@/lib/patients";
import { toAsciiDigits } from "@/lib/phone";
import { dicomPreview, isDicom, modalityLabel, parseDicomFile, type DicomMeta, type ParsedDicom } from "./dicom";
import type { MatchBy } from "./devices";
import { isPictureKind, kindFor, type FileKind } from "./kinds";

/**
 * Every image that reaches a patient by machine passes through here: a
 * registered device, a DICOM relay, the imaging station, a file dropped on the
 * Files tab. One path, so a DICOM is previewed, a series is one entry, and an
 * image nobody can place waits in the inbox — however it arrived.
 *
 * The slow parts (decoding, drawing a preview, writing to object storage)
 * happen before the transaction, so a CBCT arriving slice by slice does not
 * hold a database connection per slice while R2 answers. The transaction only
 * decides where the bytes belong.
 */

/** How long a doctor's "Take x-ray" waits. Longer, and the patient has left the chair. */
export const IMAGING_REQUEST_OPEN_FOR = "20 minutes";

/** One original DICOM object behind a file. */
export type DicomInstance = { sop: string; path: string; size: number; n: number | null };

/** `patient_files.dicom` / `imaging_inbox.dicom`. */
export type DicomRecord = {
  seriesUid: string;
  studyUid: string;
  modality: string;
  studyDate: string | null;
  description: string;
  bodyPart: string;
  /** What the machine called the patient — shown, never trusted. */
  machinePatient: DicomMeta["patient"];
  preview: boolean;
  instances: DicomInstance[];
};

export type IngestSender =
  | { device: { id: string; name: string; matchBy: MatchBy; kind?: string }; userId?: undefined; impersonatedBy?: undefined }
  | { device?: undefined; userId: string; impersonatedBy?: string | null };

export type IngestInput = {
  clinicId: string;
  from: IngestSender;
  fileName: string;
  mime: string;
  data: Buffer;
  kind?: FileKind;
  teeth?: string[];
  /** A doctor's "Take x-ray" this answers. */
  requestId?: string | null;
  /** A patient the sender names outright: a Clinicti id or `#file number`. */
  patientRef?: string | null;
  /** With nothing else to go on, answer the oldest open "Take x-ray". */
  useOpenRequest?: boolean;
  /** The folder an uploaded file sat in — often the patient's name. Shown, never trusted. */
  folder?: string | null;
};

export type IngestResult =
  | {
      placed: "patient";
      added: "new" | "series" | "duplicate";
      patientId: string;
      fileId: string;
      matchedBy: "request" | "sender" | "machine_id" | "name_birth" | "link" | "series" | "open_request";
      requestId: string | null;
    }
  | { placed: "inbox"; added: "new" | "series" | "duplicate"; inboxId: string }
  | { placed: "nowhere"; error: "patient_not_found" | "request_closed" | "series_elsewhere" };

type Run = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;

const TEETH = /^([1-8][1-8]|upper|lower|mouth|q[1-4])$/;

/** A patient by Clinicti id or file number, following a merge to the record that survived. */
export async function findPatientByRef(c: PoolClient, clinicId: string, ref: string): Promise<{ id: string; full_name: string } | null> {
  const s = toAsciiDigits(ref.trim());
  // "1042", "#1042", or "CLN-1042" — the form the Bridge's worklist gives a machine.
  const fileNo = /^(?:#|CLN-?)?(\d{1,9})$/i.exec(s)?.[1];
  let r;
  if (isUuid(s)) r = await c.query(`select id, full_name, merged_into from patients where id = $1 and clinic_id = $2`, [s, clinicId]);
  else if (fileNo) r = await c.query(`select id, full_name, merged_into from patients where file_no = $1 and clinic_id = $2`, [Number(fileNo), clinicId]);
  else return null;
  return followMerge(c, clinicId, r.rows[0]);
}

/**
 * A name as comparable words: lower case, the Arabic letters that are written
 * several ways written one way, diacritics and punctuation gone. "Haddad^Rana"
 * and "RANA HADDAD" are the same two words; so are "أحمد" and "احمد".
 */
export function nameWords(raw: string): string[] {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ًͯ-ٰٟ]/g, "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length >= 2);
}

/** What an inbox item came with about whose it is (`imaging_inbox.hint`). */
export type InboxHint = { machine?: { name?: string; birthDate?: string | null } | null; folder?: string | null; originalName?: string | null };

/**
 * The name words an inbox item came with: what the machine called the
 * patient, or else the folder and the file name — x-ray software names both
 * after the patient ("Ababneh Rakan/PAN_20261028.jpg"). Numbers (dates, image
 * counters) are no name. For suggesting whose it is, never for filing it.
 */
export function hintWords(h: InboxHint | null | undefined): string[] {
  const said = h?.machine?.name ? nameWords(h.machine.name) : [];
  const raw = said.length ? said : [...nameWords(h?.folder ?? ""), ...nameWords((h?.originalName ?? "").replace(/\.[a-z0-9]{1,5}$/i, ""))];
  return [...new Set(raw.filter((w) => !/^\d+$/.test(w)))].slice(0, 12);
}

/* ---- What a machine calls a patient ------------------------------------- */

/**
 * The patient's Clinicti number, given to them on the machine as the name of
 * their folder or file: "CLN-1042", "CLN1042_PAN.jpg". A Clinicti number
 * cannot be mistaken for the machine's own numbering, so it is believed.
 */
const CLN_IN_NAME = /(?:^|[^a-z0-9])cln-?(\d{1,9})(?![0-9])/i;
export function clinictiNumberIn(...names: (string | null | undefined)[]): string | null {
  for (const n of names) {
    const m = CLN_IN_NAME.exec(n ?? "");
    if (m) return m[1];
  }
  return null;
}

/** One way a machine named a patient: the key a link is kept under, as the machine wrote it, and its name words. */
export type SourceKey = { key: string; label: string; words: string[] };

const isNumber = (w: string) => /^\d+$/.test(w);

/**
 * The ways a machine's file says whose it is, most specific first: the
 * machine's own patient ID inside a DICOM, the folder its software keeps the
 * patient's pictures in, and the file name without its numbers (dates and
 * counters change with every picture; "Ababneh_Rakan_PAN" does not). A
 * folder or file with fewer than two words of name says nobody.
 */
export function sourceKeys(src: { machineId?: string | null; machineName?: string | null; folder?: string | null; fileName?: string | null }): SourceKey[] {
  const keys: SourceKey[] = [];
  const id = (src.machineId ?? "").trim();
  const idKey = `id:${id.toLowerCase()}`;
  // A Clinicti id is found directly; it needs no learning.
  if (id && !isUuid(id) && !/^CLN-?\d{1,9}$/i.test(id)) {
    keys.push({ key: idKey, label: id, words: nameWords(src.machineName ?? "").filter((w) => !isNumber(w)) });
  }
  const folder = (src.folder ?? "").trim();
  const inFolder = nameWords(folder);
  if (inFolder.filter((w) => !isNumber(w)).length >= 2) {
    keys.push({ key: `folder:${inFolder.join(" ")}`, label: folder, words: inFolder.filter((w) => !isNumber(w)) });
  }
  const stem = (src.fileName ?? "").replace(/\.[a-z0-9]{1,5}$/i, "");
  const inName = nameWords(stem).filter((w) => !isNumber(w));
  if (inName.length >= 2) {
    keys.push({
      key: `file:${inName.join(" ")}`,
      label: stem.replace(/\d+/g, " ").replace(/[\s_.\-]+/g, " ").trim(),
      words: inName,
    });
  }
  return keys;
}

/** How many of the patient's name words the machine's name holds — two, or all of a one-word name. */
function namesThem(words: string[], fullName: string): boolean {
  const theirs = new Set(nameWords(fullName));
  return theirs.size > 0 && words.filter((w) => theirs.has(w)).length >= Math.min(2, theirs.size);
}

/** No other patient of the clinic has a name holding all of these words. */
async function nobodyElseCalled(c: PoolClient, clinicId: string, words: string[], patientId: string): Promise<boolean> {
  if (!words.length) return false;
  const r = await c.query(
    `select full_name from patients
      where clinic_id = $1 and merged_into is null and id <> $2
        and ar_normalize(full_name) like '%' || ar_normalize($3) || '%'`,
    [clinicId, patientId, words[0]]
  );
  return !r.rows.some((p: { full_name: string }) => {
    const theirs = new Set(nameWords(p.full_name));
    return words.every((w) => theirs.has(w));
  });
}

/**
 * The patient a person once said this machine's name means. A machine ID is
 * believed only while the name inside the DICOM still shares a word with the
 * patient (two programs may both number from 1); a folder or file name only
 * while it names this patient and nobody else — a namesake registered since
 * makes it a question again, answered in the inbox.
 */
async function linkedPatient(c: PoolClient, clinicId: string, keys: SourceKey[], machineName: string | null): Promise<{ id: string; full_name: string } | null> {
  if (!keys.length) return null;
  const r = await c.query(`select key, patient_id from imaging_patient_links where clinic_id = $1 and key = any($2::text[])`, [
    clinicId,
    keys.map((k) => k.key),
  ]);
  for (const k of keys) {
    const link = r.rows.find((x: { key: string }) => x.key === k.key);
    if (!link) continue;
    const p = await findPatientByRef(c, clinicId, link.patient_id);
    if (!p) continue;
    const theirs = new Set(nameWords(p.full_name));
    if (k.key.startsWith("id:")) {
      if (!nameWords(machineName ?? "").some((w) => theirs.has(w))) continue;
    } else if (!(await nobodyElseCalled(c, clinicId, k.words.filter((w) => theirs.has(w)), p.id))) {
      continue;
    }
    await c.query(`update imaging_patient_links set last_used_at = now() where clinic_id = $1 and key = $2`, [clinicId, k.key]);
    return p;
  }
  return null;
}

/**
 * A person filed a picture to a patient: what the machine called it now
 * means that patient, from the next picture on. Only a name that holds the
 * patient's own name is learned — a date folder, "Images" or "PAN_0001"
 * never becomes anybody's — and filing it elsewhere later moves the link.
 */
export async function learnLinks(
  c: PoolClient,
  o: { clinicId: string; patient: { id: string; full_name: string }; machine?: { id?: string; name?: string } | null; folder?: string | null; fileName?: string | null; userId: string }
): Promise<string[]> {
  const keys = sourceKeys({ machineId: o.machine?.id, machineName: o.machine?.name, folder: o.folder, fileName: o.fileName });
  const learned: string[] = [];
  for (const k of keys) {
    if (!namesThem(k.words, o.patient.full_name)) continue;
    await c.query(
      `insert into imaging_patient_links (clinic_id, patient_id, key, label, created_by) values ($1, $2, $3, $4, $5)
       on conflict (clinic_id, key) do update
         set patient_id = excluded.patient_id, label = excluded.label, created_by = excluded.created_by, created_at = now(), last_used_at = null`,
      [o.clinicId, o.patient.id, k.key, k.label.slice(0, 120), o.userId]
    );
    learned.push(k.label);
  }
  return learned;
}

/**
 * The one patient whose birth date is this and whose name holds every word
 * the machine's name has — at least two of them. More than one such patient
 * (twins, a namesake born the same day) is nobody: the image waits for a
 * person to choose.
 */
async function findPatientByNameAndBirth(
  c: PoolClient,
  clinicId: string,
  name: string,
  birthDate: string
): Promise<{ id: string; full_name: string } | null> {
  const words = nameWords(name);
  if (words.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const r = await c.query(
    `select id, full_name from patients where clinic_id = $1 and merged_into is null and birth_date = $2::date`,
    [clinicId, birthDate]
  );
  const hits = r.rows.filter((p: { full_name: string }) => {
    const theirs = new Set(nameWords(p.full_name));
    return words.every((w) => theirs.has(w));
  });
  return hits.length === 1 ? { id: hits[0].id, full_name: hits[0].full_name } : null;
}

async function findPatientByNationalId(c: PoolClient, clinicId: string, raw: string) {
  const nid = nationalIdOf(raw);
  if (!nid) return null;
  const r = await c.query(
    `select id, full_name, merged_into from patients where national_id = $1 and clinic_id = $2 order by merged_into nulls first limit 1`,
    [nid, clinicId]
  );
  return followMerge(c, clinicId, r.rows[0]);
}

async function followMerge(
  c: PoolClient,
  clinicId: string,
  row: { id: string; full_name: string; merged_into: string | null } | undefined
): Promise<{ id: string; full_name: string } | null> {
  for (let hops = 0; row && row.merged_into && hops < 5; hops++) {
    row = (await c.query(`select id, full_name, merged_into from patients where id = $1 and clinic_id = $2`, [row.merged_into, clinicId])).rows[0];
  }
  return row && !row.merged_into ? { id: row.id, full_name: row.full_name } : null;
}

function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 80) || "image";
}

/** "Panoramic x-ray · 2026-10-07" — what the file is called on the Files tab. */
function dicomTitle(meta: DicomMeta, fallback: string): string {
  const what = meta.description || modalityLabel(meta.modality);
  return [what, meta.studyDate].filter(Boolean).join(" · ") || baseName(fallback);
}

export async function ingestImage(input: IngestInput, run: Run): Promise<IngestResult> {
  const { clinicId } = input;
  const teeth = [...new Set((input.teeth ?? []).filter((t) => TEETH.test(t)))];
  const parsed: ParsedDicom | null = isDicom(input.data) ? parseDicomFile(input.data) : null;
  const meta = parsed?.meta ?? null;
  const device = input.from.device ?? null;
  // What it is: the sender's word if given, else the machine, the DICOM inside, the file.
  const kind: FileKind =
    input.kind ??
    kindFor({ deviceKind: device?.kind, modality: meta?.modality, mime: meta ? "application/dicom" : input.mime, picture: !!parsed || input.mime.startsWith("image/") });
  const userId = input.from.userId ?? null;

  /*
    A series already on file only gains an original, and a known instance
    gains nothing — but only when it is the patient the sender meant. The same
    OPG uploaded to a different patient is a mistake to refuse, not a reason
    to hand that patient somebody else's x-ray.
  */
  let fresh = true;
  if (meta) {
    const early = await run(async (c) => {
      const known = await seriesHolder(c, clinicId, meta.seriesUid);
      if (!known || !known.instances.some((i) => i.sop === meta.sopUid)) return { known, dup: null };
      const named = await namedPatient(c, clinicId, input);
      if (named && "id" in named && known.patientId && named.id !== known.patientId) return { known, dup: null };
      return { known, dup: dupResult(known) };
    });
    if (early.dup) return early.dup;
    fresh = !early.known;
  }

  // ---- bytes first, outside any transaction
  const folder = "imaging";
  const uploaded: string[] = [];
  let mainPath: string;
  let mainMime: string;
  let mainName: string;
  let size = 0;
  let record: DicomRecord | null = null;
  let instance: DicomInstance | null = null;

  if (meta && parsed) {
    const orig = await saveFile(clinicId, `${folder}/dicom`, `${meta.sopUid}.dcm`, input.data);
    uploaded.push(orig.storagePath);
    instance = { sop: meta.sopUid, path: orig.storagePath, size: orig.sizeBytes, n: meta.instanceNumber };
    size += orig.sizeBytes;
    const preview = fresh ? await dicomPreview(parsed) : null;
    const title = dicomTitle(meta, input.fileName);
    if (preview) {
      const p = await saveFile(clinicId, folder, `${title}.${preview.ext}`, preview.data);
      uploaded.push(p.storagePath);
      size += p.sizeBytes;
      mainPath = p.storagePath;
      mainMime = preview.mime;
      mainName = `${title}.${preview.ext}`;
    } else {
      mainPath = orig.storagePath;
      mainMime = "application/dicom";
      mainName = `${title}.dcm`;
    }
    record = {
      seriesUid: meta.seriesUid,
      studyUid: meta.studyUid,
      modality: meta.modality,
      studyDate: meta.studyDate,
      description: meta.description,
      bodyPart: meta.bodyPart,
      machinePatient: meta.patient,
      preview: !!preview,
      instances: [instance],
    };
  } else {
    const f = await saveFile(clinicId, folder, input.fileName, input.data);
    uploaded.push(f.storagePath);
    size = f.sizeBytes;
    mainPath = f.storagePath;
    mainMime = input.mime || "application/octet-stream";
    mainName = input.fileName;
  }

  let discard: string[] = [];
  try {
    const result = await run(async (c): Promise<IngestResult> => {
      const auditBase = { clinicId, userId, impersonatedBy: input.from.impersonatedBy ?? null };
      const countIt = async () => {
        if (device) await c.query(`update clinic_devices set images_received = images_received + 1 where id = $1`, [device.id]);
      };

      // ---- whom the sender names
      const named = await namedPatient(c, clinicId, input, true);
      if (named && "error" in named) {
        discard = uploaded;
        return { placed: "nowhere", error: named.error };
      }
      let patient = named ? { id: named.id, full_name: named.full_name } : null;
      let request = named?.request ?? null;
      let matchedBy: PatientMatch = named?.request ? "request" : "sender";

      // ---- a series already here
      if (meta && instance) {
        // Two slices of a new series arriving together must not both start it.
        await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`imaging:${clinicId}:${meta.seriesUid}`]);
        const known = await seriesHolder(c, clinicId, meta.seriesUid);
        if (known) {
          if (patient && known.patientId && known.patientId !== patient.id) {
            discard = uploaded;
            return { placed: "nowhere", error: "series_elsewhere" };
          }
          if (known.instances.some((i) => i.sop === meta.sopUid)) {
            discard = uploaded;
            return dupResult(known);
          }
          // The preview drawn for a series that turned out to exist is not needed.
          discard = uploaded.filter((p) => p !== instance!.path);
          await c.query(
            `update ${known.table}
                set dicom = jsonb_set(dicom, '{instances}', (dicom->'instances') || $2::jsonb),
                    size_bytes = size_bytes + $3
              where id = $1`,
            [known.id, JSON.stringify([instance]), instance.size]
          );
          await countIt();
          if (known.table === "imaging_inbox") return { placed: "inbox", added: "series", inboxId: known.id };
          if (request) await fulfil(c, request, known.id);
          return {
            placed: "patient",
            added: "series",
            patientId: known.patientId!,
            fileId: known.id,
            matchedBy: request ? matchedBy : "series",
            requestId: request?.id ?? null,
          };
        }
      }

      // ---- what the machine says, then whoever is waiting at the machine
      if (!patient && meta && device && device.matchBy !== "none" && meta.patient.id) {
        patient =
          device.matchBy === "national_id"
            ? await findPatientByNationalId(c, clinicId, meta.patient.id)
            : await findPatientByRef(c, clinicId, meta.patient.id);
        matchedBy = "machine_id";
      }
      /*
        A Clinicti id the machine was given cannot collide with another
        system's numbers — neither a patient uuid nor "CLN-1042", the form the
        Bridge's worklist hands a machine, whatever the device's setting.
      */
      if (!patient && meta && (isUuid(meta.patient.id) || /^CLN-?\d{1,9}$/i.test(meta.patient.id))) {
        patient = await findPatientByRef(c, clinicId, meta.patient.id);
        matchedBy = "machine_id";
      }
      /*
        Two identifiers, the way a nurse checks a wristband: the name the
        machine's software holds and the birth date, together matching one
        patient and only one. Every vendor's software writes both into its
        DICOM, so an image exported from Carestream or Planmeca finds its
        patient without anyone having set the machine up for Clinicti.
      */
      if (!patient && meta && meta.patient.birthDate && meta.patient.name) {
        const found = await findPatientByNameAndBirth(c, clinicId, meta.patient.name, meta.patient.birthDate);
        if (found) {
          patient = found;
          matchedBy = "name_birth";
        }
      }
      /*
        The machine's software, told who the patient is in Clinicti's words:
        their Clinicti number as the name of the folder or the file.
      */
      if (!patient) {
        const n = clinictiNumberIn(input.folder, input.fileName);
        const found = n ? await findPatientByRef(c, clinicId, `CLN-${n}`) : null;
        if (found) {
          patient = found;
          matchedBy = "machine_id";
        }
      }
      /*
        What a person once told Clinicti this machine's name for a patient
        means — learned the first time they filed one of its pictures — so
        every picture after it goes straight to them.
      */
      if (!patient) {
        const keys = sourceKeys({ machineId: meta?.patient.id, machineName: meta?.patient.name, folder: input.folder, fileName: input.fileName });
        const found = await linkedPatient(c, clinicId, keys, meta?.patient.name ?? null);
        if (found) {
          patient = found;
          matchedBy = "link";
        }
      }
      /*
        Which open requests this file may answer. One that names a machine is
        that machine's alone. "Take x-ray" or "Take photo" wants a picture —
        never an STL or a PDF; "Request from device" with no machine named
        wants whatever result comes. Requests naming this machine go first.
      */
      const answerable = `(r.device_id is null or r.device_id = $D::uuid)
        and (r.kind = 'file' or r.device_id = $D::uuid or $P::boolean)
        and r.fulfilled_at is null and r.cancelled_at is null
        and r.created_at > now() - interval '${IMAGING_REQUEST_OPEN_FOR}'`;
      const answerParams = (n: number) => answerable.replaceAll("$D", `$${n}`).replaceAll("$P", `$${n + 1}`);
      const picture = isPictureKind(kind);
      // Filed by who it is: the request waiting on this patient is answered too.
      if (patient && !request) {
        const waiting = await c.query(
          `select r.id, r.teeth, r.kind from imaging_requests r
            where r.clinic_id = $1 and r.patient_id = $2 and ${answerParams(3)}
            order by (r.device_id is not null) desc, r.created_at limit 1 for update skip locked`,
          [clinicId, patient.id, device?.id ?? null, picture]
        );
        if (waiting.rowCount) request = { id: waiting.rows[0].id, teeth: waiting.rows[0].teeth, kind: waiting.rows[0].kind };
      }
      if (!patient && input.useOpenRequest) {
        const r = await c.query(
          `select r.id, r.patient_id, r.teeth, r.kind from imaging_requests r
            where r.clinic_id = $1 and ${answerParams(2)}
            order by (r.device_id is not null) desc, r.created_at limit 1 for update skip locked`,
          [clinicId, device?.id ?? null, picture]
        );
        if (r.rowCount) {
          request = { id: r.rows[0].id, teeth: r.rows[0].teeth, kind: r.rows[0].kind };
          patient = await findPatientByRef(c, clinicId, r.rows[0].patient_id);
          matchedBy = "open_request";
        }
      }

      // A picture asked for as an x-ray or a photo is filed as one; anything else keeps its own kind.
      const fileKind: FileKind = request && request.kind !== "file" && picture ? request.kind : kind;
      const fileTeeth = [...new Set([...teeth, ...(request?.teeth ?? [])])].sort();

      if (!patient) {
        const hint = {
          ...(input.patientRef ? { ref: input.patientRef } : {}),
          ...(meta?.patient.id || meta?.patient.name ? { machine: meta!.patient } : {}),
          ...(input.folder ? { folder: input.folder } : {}),
          originalName: input.fileName,
        };
        const r = await c.query(
          `insert into imaging_inbox (clinic_id, device_id, file_name, mime_type, size_bytes, storage_path, kind, teeth, dicom, hint)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [clinicId, device?.id ?? null, mainName, mainMime, size, mainPath, fileKind, fileTeeth, record ? JSON.stringify(record) : null, JSON.stringify(hint)]
        );
        await countIt();
        await audit(c, {
          ...auditBase,
          action: "imaging.inbox.receive",
          entity: "imaging_inbox",
          entityId: r.rows[0].id,
          detail: { device: device?.id ?? null, name: mainName, modality: meta?.modality ?? null },
        });
        return { placed: "inbox", added: "new", inboxId: r.rows[0].id };
      }

      const f = await c.query(
        `insert into patient_files (clinic_id, patient_id, uploaded_by, file_name, mime_type, size_bytes, storage_path, kind, teeth, device_id, dicom)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [clinicId, patient.id, userId, mainName, mainMime, size, mainPath, fileKind, fileTeeth, device?.id ?? null, record ? JSON.stringify(record) : null]
      );
      const fileId = f.rows[0].id as string;
      if (request) await fulfil(c, request, fileId);
      await countIt();
      await audit(c, {
        ...auditBase,
        action: device ? "imaging.device.receive" : "patient.file.upload",
        entity: "patient_file",
        entityId: fileId,
        detail: {
          patientId: patient.id,
          name: mainName,
          device: device?.id ?? null,
          matchedBy,
          request: request?.id ?? null,
          modality: meta?.modality ?? null,
        },
      });
      return { placed: "patient", added: "new", patientId: patient.id, fileId, matchedBy, requestId: request?.id ?? null };
    });
    if (discard.length) await deleteFiles(discard);
    return result;
  } catch (e) {
    await deleteFiles(uploaded);
    throw e;
  }
}

type PatientMatch = Extract<IngestResult, { placed: "patient" }>["matchedBy"];
type OpenRequest = { id: string; teeth: string[]; kind: "xray" | "photo" | "file" };

/**
 * The patient the sender names — through a "Take x-ray" or outright. With
 * `strict`, a name that resolves to nobody is an error for a person (they
 * picked that patient) and nothing for a device (it falls through to the
 * machine's own ID, an open request, or the inbox).
 */
async function namedPatient(
  c: PoolClient,
  clinicId: string,
  input: IngestInput,
  strict = false
): Promise<
  | { id: string; full_name: string; request: OpenRequest | null }
  | { error: "request_closed" | "patient_not_found" }
  | null
> {
  if (input.requestId) {
    const r = await c.query(
      `select id, patient_id, teeth, kind from imaging_requests
        where id = $1 and clinic_id = $2 and fulfilled_at is null and cancelled_at is null`,
      [input.requestId, clinicId]
    );
    if (!r.rowCount) return strict ? { error: "request_closed" } : null;
    const p = await findPatientByRef(c, clinicId, r.rows[0].patient_id);
    if (!p) return strict ? { error: "patient_not_found" } : null;
    return { ...p, request: { id: r.rows[0].id, teeth: r.rows[0].teeth, kind: r.rows[0].kind } };
  }
  if (input.patientRef) {
    const p = await findPatientByRef(c, clinicId, input.patientRef);
    if (p) return { ...p, request: null };
    return strict && !input.from.device ? { error: "patient_not_found" } : null;
  }
  return null;
}

async function fulfil(c: PoolClient, request: OpenRequest, fileId: string) {
  await c.query(
    `update patient_files set teeth = (select array(select distinct unnest(teeth || $2::text[]) order by 1)) where id = $1`,
    [fileId, request.teeth]
  );
  await c.query(`update imaging_requests set fulfilled_at = now(), file_id = $2 where id = $1 and fulfilled_at is null`, [
    request.id,
    fileId,
  ]);
}

function dupResult(known: Holder): IngestResult {
  return known.table === "patient_files"
    ? { placed: "patient", added: "duplicate", patientId: known.patientId!, fileId: known.id, matchedBy: "series", requestId: null }
    : { placed: "inbox", added: "duplicate", inboxId: known.id };
}

type Holder = {
  table: "patient_files" | "imaging_inbox";
  id: string;
  patientId: string | null;
  instances: DicomInstance[];
};

/** Where a series already lives: a patient's file, or an inbox item still waiting. */
async function seriesHolder(c: PoolClient, clinicId: string, seriesUid: string): Promise<Holder | null> {
  const f = await c.query(
    `select id, patient_id, dicom->'instances' as instances from patient_files
      where clinic_id = $1 and dicom is not null and dicom->>'seriesUid' = $2`,
    [clinicId, seriesUid]
  );
  if (f.rowCount) return { table: "patient_files", id: f.rows[0].id, patientId: f.rows[0].patient_id, instances: f.rows[0].instances ?? [] };
  const i = await c.query(
    `select id, dicom->'instances' as instances from imaging_inbox
      where clinic_id = $1 and dicom is not null and dicom->>'seriesUid' = $2
        and assigned_at is null and discarded_at is null`,
    [clinicId, seriesUid]
  );
  if (i.rowCount) return { table: "imaging_inbox", id: i.rows[0].id, patientId: null, instances: i.rows[0].instances ?? [] };
  return null;
}

/** Every stored object behind a file or an inbox item — the preview and each original. */
export function storedPaths(row: { storage_path: string; dicom?: DicomRecord | null }): string[] {
  return [row.storage_path, ...(row.dicom?.instances ?? []).map((i) => i.path)];
}

/**
 * An inbox item, filed to a patient. A series that meanwhile reached the
 * patient's file another way (the same OPG sent twice) joins that file
 * instead of becoming a second one.
 */
export async function fileInboxItem(
  c: PoolClient,
  opts: { clinicId: string; inboxId: string; patientId: string; teeth?: string[]; userId: string; impersonatedBy?: string | null }
): Promise<{ fileId: string; patientId: string; learned: string[] } | { error: "not_found" | "patient_not_found" }> {
  const r = await c.query(
    `select * from imaging_inbox where id = $1 and clinic_id = $2 and assigned_at is null and discarded_at is null for update`,
    [opts.inboxId, opts.clinicId]
  );
  const item = r.rows[0];
  if (!item) return { error: "not_found" };
  const patient = await findPatientByRef(c, opts.clinicId, opts.patientId);
  if (!patient) return { error: "patient_not_found" };
  const teeth = [...new Set([...(item.teeth ?? []), ...(opts.teeth ?? []).filter((t) => TEETH.test(t))])].sort();
  const dicom = item.dicom as DicomRecord | null;

  let fileId: string;
  const existing = dicom
    ? (
        await c.query(`select id from patient_files where clinic_id = $1 and dicom is not null and dicom->>'seriesUid' = $2`, [
          opts.clinicId,
          dicom.seriesUid,
        ])
      ).rows[0]
    : null;
  if (existing && dicom) {
    fileId = existing.id;
    await c.query(
      `update patient_files set dicom = jsonb_set(dicom, '{instances}', (dicom->'instances') || $2::jsonb), size_bytes = size_bytes + $3 where id = $1`,
      [fileId, JSON.stringify(dicom.instances), item.size_bytes]
    );
  } else {
    const f = await c.query(
      `insert into patient_files (clinic_id, patient_id, uploaded_by, file_name, mime_type, size_bytes, storage_path, kind, teeth, device_id, dicom)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [opts.clinicId, patient.id, opts.userId, item.file_name, item.mime_type, item.size_bytes, item.storage_path, item.kind, teeth, item.device_id, dicom ? JSON.stringify(dicom) : null]
    );
    fileId = f.rows[0].id;
  }
  await c.query(`update imaging_inbox set assigned_file_id = $2, assigned_at = now(), assigned_by = $3 where id = $1`, [
    item.id,
    fileId,
    opts.userId,
  ]);
  // Whose it is, now a person has said so: the machine's next picture of them needs nobody.
  const hint = (item.hint ?? {}) as InboxHint;
  const learned = await learnLinks(c, {
    clinicId: opts.clinicId,
    patient,
    machine: dicom?.machinePatient ?? hint.machine ?? null,
    folder: hint.folder,
    fileName: hint.originalName ?? item.file_name,
    userId: opts.userId,
  });
  await audit(c, {
    clinicId: opts.clinicId,
    userId: opts.userId,
    impersonatedBy: opts.impersonatedBy ?? null,
    action: "imaging.inbox.file",
    entity: "patient_file",
    entityId: fileId,
    detail: { patientId: patient.id, inbox: item.id, name: item.file_name, learned },
  });
  return { fileId, patientId: patient.id, learned };
}
