"use client";

/*
  The Devices page: what the clinic's machines send, for every kind of clinic.

  Most machines — an x-ray sensor, an ECG cart, an eye scanner, an ultrasound —
  hand their results to the vendor's software on the PC beside them, and that
  software saves each one into a folder. The Clinicti Bridge watches that
  folder from the PC itself. Where nothing can be installed, this page, open on
  that PC, can do the same while it stays open: the browser is given read
  access to the folder once (Chrome and Edge can; the choice is remembered on
  this computer), looks every two seconds for files that were not there
  before, waits until a file has stopped growing, and sends it.

  Where a result goes is decided by the server, never by this browser:
  "Request from device" in a patient's Files (or "Take x-ray" on a tooth)
  leaves a request waiting here, and the next result answers it. A result
  nobody asked for, and whose machine did not say whose it is, waits in the
  clinic's one inbox below until somebody files it — never guessed.

  Nothing is installed and no vendor software is changed. The machine's
  software is only asked to do what it already does: save the result.

  Where neither the Bridge nor watching can run, the folder is uploaded:
  every result in it, now, from any browser. This computer remembers what it
  has sent, so the same folder uploaded again tomorrow sends only what is new
  — and watching offers to send what was already there when it began.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, FolderOpen, FolderUp, Inbox, Radiation, Send, Trash2, Upload, WifiOff, X } from "lucide-react";
import { bridgeOffline } from "@/lib/imaging/offline";
import { folderItems, isDicomFile, isKnownResult, mayBeResult, parentFolder, resultsIn } from "@/lib/imaging/folder-files";
import { DEVICE_FILE_KIND, FILE_KINDS } from "@/lib/imaging/kinds";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/modal";
import { buttonClass } from "@/components/ui/button-class";
import { fmtDateOnly, fmtRelative } from "@/lib/dates";

type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> };
type DirHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FileHandle | DirHandle>;
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
};
type Picker = { showDirectoryPicker?: (o?: { id?: string; mode?: "read" }) => Promise<DirHandle> };

type Request = {
  id: string;
  patient_id: string;
  patient_name: string;
  teeth: string[];
  kind: "xray" | "photo" | "file";
  created_at: string;
  requested_by_name: string | null;
  device_name: string | null;
  note: string;
};
export type StationDevice = { id: string; name: string; kind: string; method: string; paired_at: string | null; revoked_at: string | null; last_seen_at: string | null; host: string | null };
type InboxItem = {
  id: string;
  file_name: string;
  mime_type: string;
  kind: "xray" | "photo";
  teeth: string[];
  received_at: string;
  hint: { ref?: string; machine?: { id: string; name: string; birthDate: string | null }; folder?: string; originalName?: string };
  modality: string | null;
  description: string | null;
  study_date: string | null;
  instances: number;
  device_name: string | null;
  /** Likely patients, from the name and birth date the machine gave. */
  suggestions?: { id: string; full_name: string; file_no: number | null; birth_date: string | null }[];
};
type Found = { id: string; full_name: string; phone_e164: string | null; file_no?: number | null };
type Sent = { key: string; name: string; patient: string; teeth: string[]; at: number };
type Placed =
  | { placed: "patient"; added: string; patientName: string; teeth: string[]; requestId: string | null }
  | { placed: "inbox"; added: string };
/** A folder upload under way, then what became of it. */
type Bulk = { folder: string; found: number; total: number; done: number; patient: number; inbox: number; before: number; failed: number; finished: boolean };
type PastFile = { path: string; file: File };

const SCAN_MS = 2000;
/** Files of one folder upload in flight at once. */
const BULK_LANES = 3;

/* What this computer has sent, by path, size and time — so a folder uploaded again sends only what is new. */
const SENT_MAX = 10000;
const sentStore = (slug: string) => `clinicti-sent:${slug}`;
const sentKey = (path: string, f: File) => `${path}|${f.size}|${f.lastModified}`;
function loadSent(slug: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(sentStore(slug)) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function rememberSent(slug: string, keys: string[]) {
  if (!keys.length) return;
  try {
    const all = loadSent(slug);
    for (const k of keys) all.add(k);
    localStorage.setItem(sentStore(slug), JSON.stringify([...all].slice(-SENT_MAX)));
  } catch {
    // A private window, or storage full: the next upload sends these again, and a DICOM is still kept once.
  }
}

/* The chosen folder, remembered on this computer between visits. */
const DB = "clinicti-imaging";
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("handles");
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        const tx = open.result.transaction("handles", mode);
        const req = fn(tx.objectStore("handles"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      };
    } catch {
      resolve(undefined);
    }
  });
}

function mimeOf(f: File): string {
  if (f.type) return f.type;
  if (/\.dcm$/i.test(f.name)) return "application/dicom";
  if (/\.tiff?$/i.test(f.name)) return "image/tiff";
  return "application/octet-stream";
}

async function* walk(dir: DirHandle, prefix = "", depth = 0): AsyncGenerator<{ path: string; handle: FileHandle }> {
  for await (const h of dir.values()) {
    if (h.kind === "file") {
      if (mayBeResult(h.name)) yield { path: prefix + h.name, handle: h };
    } else if (depth < 2) {
      // Many x-ray programs file each day or each patient in a subfolder.
      yield* walk(h, `${prefix}${h.name}/`, depth + 1);
    }
  }
}

export function DevicesStation({ slug, devices, canManageDevices }: { slug: string; devices: StationDevice[]; canManageDevices: boolean }) {
  const { t, locale } = useI18n();
  const T = t.station;
  const { toast } = useToast();
  const [supported, setSupported] = useState(true);
  const [folder, setFolder] = useState<DirHandle | null>(null);
  const [watching, setWatching] = useState(false);
  const [requests, setRequests] = useState<Request[]>([]);
  const [sent, setSent] = useState<Sent[]>([]);
  const requestsRef = useRef<Request[]>([]);
  requestsRef.current = requests;

  /* What the machines sent for nobody — the clinic's, not this computer's. */
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  // The clock, read in the browser only, for "offline since".
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const loadInbox = useCallback(async () => {
    try {
      const res = await fetch(`/api/c/${slug}/imaging/inbox`, { cache: "no-store" });
      const body = (await res.json()) as { items?: InboxItem[] };
      if (body.items) setInbox(body.items);
    } catch {
      // The next look tries again.
    }
  }, [slug]);
  useEffect(() => {
    void loadInbox();
    const id = setInterval(loadInbox, 5000);
    return () => clearInterval(id);
  }, [loadInbox]);

  /* What is waiting: polled, because the station has nothing else to do. */
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/c/${slug}/imaging/requests`);
      const body = (await res.json()) as { requests?: Request[] };
      if (body.requests) setRequests(body.requests);
    } catch {
      // The next poll tries again.
    }
  }, [slug]);
  useEffect(() => {
    void poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [poll]);

  /*
    Every file goes to the server, which decides — never this browser: a
    DICOM slice joins its series, a file whose machine or DICOM says whose it
    is goes to that patient, the next file answers whoever is waiting, and the
    rest wait to be filed in the clinic's one inbox below.
  */
  // What the folder's pictures are: a panoramic machine's JPEG is an x-ray, not a photo.
  const [kind, setKind] = useState<string>(() => devices.map((d) => (DEVICE_FILE_KIND as Record<string, string>)[d.kind]).find((k) => k && k !== "other") ?? "xray");
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const post = useCallback(
    async (file: File, opts: { bulk?: boolean; folder?: string | null } = {}): Promise<Placed | "not_result" | null> => {
      const dicom = await isDicomFile(file);
      // A file with no extension that is not DICOM is not a result at all.
      if (!dicom && !isKnownResult(file.name)) return "not_result";
      const fd = new FormData();
      fd.set("file", new File([file], file.name, { type: dicom ? "application/dicom" : mimeOf(file), lastModified: file.lastModified }));
      fd.set("kind", kindRef.current);
      if (opts.bulk) fd.set("bulk", "1");
      if (opts.folder) fd.set("folder", opts.folder);
      try {
        const res = await fetch(`/api/c/${slug}/imaging/receive`, { method: "POST", body: fd });
        const body = (await res.json().catch(() => null)) as Placed | null;
        return res.ok && body ? body : null;
      } catch {
        return null;
      }
    },
    [slug]
  );

  const noteSent = useCallback((name: string, body: Extract<Placed, { placed: "patient" }>) => {
    setSent((prev) => [{ key: `${name}-${Date.now()}-${Math.random()}`, name, patient: body.patientName, teeth: body.teeth, at: Date.now() }, ...prev].slice(0, 30));
  }, []);

  /** One file, as it arrives: from the watched folder (with its path there) or picked by hand. */
  const arrive = useCallback(
    async (file: File, path?: string) => {
      const body = await post(file, { folder: path ? parentFolder(path) : null });
      if (body === "not_result") return;
      if (!body) {
        toast(T.failed, "error");
      } else {
        if (path) rememberSent(slug, [sentKey(path, file)]);
        if (body.placed === "inbox") {
          if (body.added === "new") toast(T.toInbox);
          void loadInbox();
        } else {
          if (body.requestId) setRequests((prev) => prev.filter((r) => r.id !== body.requestId));
          noteSent(file.name, body);
          if (body.added === "new") toast(T.sent.replace("{patient}", body.patientName));
        }
      }
      void poll();
    },
    [slug, post, toast, T.toInbox, T.sent, T.failed, loadInbox, poll, noteSent]
  );

  /*
    A whole folder at once: what is in it now, from any browser. None of it
    answers the patient in the chair — the server is told it is the past.
    Each file sent is remembered on this computer as it goes, so a tab closed
    halfway, or the folder uploaded again tomorrow, sends only the rest.
  */
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const bulkRunning = useRef(false);
  const sendAll = useCallback(
    async (folderName: string, items: { file: File; path: string }[]) => {
      if (bulkRunning.current) return;
      bulkRunning.current = true;
      setBulk({ folder: folderName, found: 0, total: 0, done: 0, patient: 0, inbox: 0, before: 0, failed: 0, finished: false });
      try {
        const results = await resultsIn(items);
        const memory = loadSent(slug);
        const todo = results.filter((it) => !memory.has(sentKey(it.path, it.file)));
        setBulk((b) => b && { ...b, found: results.length, total: todo.length, before: results.length - todo.length });
        let next = 0;
        let pending: string[] = [];
        const lane = async () => {
          while (next < todo.length) {
            const it = todo[next++];
            const body = await post(it.file, { bulk: true, folder: parentFolder(it.path) });
            const placed = body && body !== "not_result" ? body : null;
            if (placed) pending.push(sentKey(it.path, it.file));
            if (pending.length >= 25) {
              rememberSent(slug, pending);
              pending = [];
            }
            if (placed?.placed === "patient" && placed.added === "new") noteSent(it.file.name, placed);
            const outcome = !placed ? "failed" : placed.added === "duplicate" ? "before" : placed.placed;
            setBulk((b) => b && { ...b, done: b.done + 1, [outcome]: b[outcome] + 1 });
          }
        };
        await Promise.all(Array.from({ length: Math.min(BULK_LANES, todo.length) }, lane));
        rememberSent(slug, pending);
      } finally {
        bulkRunning.current = false;
        setBulk((b) => b && { ...b, finished: true });
        void loadInbox();
      }
    },
    [slug, post, noteSent, loadInbox]
  );
  const folderPick = useRef<HTMLInputElement>(null);

  /*
    Watching: everything in the folder when watching starts is the past and is
    left alone. A file that appears is sent once it has been the same size on
    two looks in a row — an x-ray program writes a large file in pieces, and a
    half-written image is no use to anybody.
  */
  const seen = useRef<Set<string>>(new Set());
  const growing = useRef<Map<string, number>>(new Map());
  // What was there when watching began and this computer never sent: offered, not sent unasked.
  const [past, setPast] = useState<PastFile[]>([]);
  useEffect(() => {
    if (!folder || !watching) return;
    let stop = false;
    let first = true;
    const found: PastFile[] = [];
    const look = async () => {
      try {
        for await (const { path, handle } of walk(folder)) {
          if (stop) return;
          if (seen.current.has(path)) continue;
          const f = await handle.getFile();
          if (first) {
            seen.current.add(path);
            found.push({ path: `${folder.name}/${path}`, file: f });
            continue;
          }
          const before = growing.current.get(path);
          if (before === f.size && f.size > 0) {
            seen.current.add(path);
            growing.current.delete(path);
            void arrive(f, `${folder.name}/${path}`);
          } else {
            growing.current.set(path, f.size);
          }
        }
        if (first && !stop) {
          const memory = loadSent(slug);
          setPast(found.filter((p) => !memory.has(sentKey(p.path, p.file))));
        }
        first = false;
      } catch {
        // The folder went away or access was withdrawn: stop and ask again.
        setWatching(false);
      }
    };
    void look();
    const id = setInterval(look, SCAN_MS);
    return () => {
      stop = true;
      clearInterval(id);
      setPast([]);
    };
  }, [folder, watching, arrive, slug]);

  // The folder chosen last time on this computer, if any. Reading it again
  // needs a click (the browser's rule), so it waits as "Resume watching".
  useEffect(() => {
    const w = window as unknown as Picker;
    if (!w.showDirectoryPicker) {
      setSupported(false);
      return;
    }
    void idb<DirHandle>("readonly", (s) => s.get(slug) as IDBRequest<DirHandle>).then((h) => {
      if (!h) return;
      setFolder(h);
      void h.queryPermission?.({ mode: "read" }).then((p) => p === "granted" && setWatching(true));
    });
  }, [slug]);

  const choose = async () => {
    const w = window as unknown as Picker;
    try {
      const h = await w.showDirectoryPicker!({ id: "clinicti-xray", mode: "read" });
      await idb("readwrite", (s) => s.put(h, slug));
      seen.current = new Set();
      growing.current = new Map();
      setFolder(h);
      setWatching(true);
    } catch {
      // Closed without choosing.
    }
  };
  const resume = async () => {
    if (!folder) return;
    const p = (await folder.requestPermission?.({ mode: "read" })) ?? "granted";
    if (p === "granted") setWatching(true);
  };

  const cancel = async (id: string) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
    await fetch(`/api/c/${slug}/imaging/requests/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "cancel" }) }).catch(() => {});
  };

  const handPick = useRef<HTMLInputElement>(null);

  return (
    <div className="mx-auto grid max-w-3xl gap-4" data-imaging-station>
      <div>
        <h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-ink-900">
          <Radiation className="h-6 w-6 text-brand-700" />
          {T.title}
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-700">{T.intro}</p>
      </div>

      {/* A machine's computer gone quiet: said before somebody takes an x-ray that will not arrive. */}
      {devices.filter((d) => bridgeOffline(d, now)).map((d) => (
        <div key={d.id} className="flex items-start gap-3 rounded-card border border-danger/30 bg-danger-soft px-4 py-3 text-[13.5px] text-ink-900" data-device-offline={d.id}>
          <WifiOff className="mt-0.5 h-4.5 w-4.5 shrink-0 text-danger" />
          <span>
            <b>{d.name}</b> — {T.offline.replace("{host}", d.host || T.theComputer).replace("{t}", fmtRelative(d.last_seen_at!, locale))}
          </span>
        </div>
      ))}

      <Card className="p-4">
        <div className="grid gap-3" data-folder-card>
          <div>
            <h2 className="text-[15px] font-semibold text-ink-900">{T.folderTitle}</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-500">{T.folderIntro}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex items-center gap-2 text-[13px] text-ink-700">
              {T.theseAre}
              <Select value={kind} onChange={(e) => setKind(e.target.value)} className="!w-auto" data-folder-kind>
                {FILE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {(t.patients.files.kinds as Record<string, string>)[k] ?? k}
                  </option>
                ))}
              </Select>
            </label>
            <Button onClick={() => folderPick.current?.click()} loading={!!bulk && !bulk.finished} data-upload-folder>
              <FolderUp className="h-4 w-4" />
              {T.uploadFolder}
            </Button>
            <input
              ref={folderPick}
              // Not in React's types; every browser takes it. In the HTML, so it holds before hydration too.
              {...{ webkitdirectory: "" }}
              type="file"
              multiple
              hidden
              data-folder-input
              onChange={(e) => {
                const items = folderItems(e.target.files);
                e.target.value = "";
                const name = items[0]?.path.split("/")[0] ?? "";
                if (items.length) void sendAll(name, items);
              }}
            />
            {supported && !watching && folder && (
              <Button variant="outline" onClick={resume}>
                <FolderOpen className="h-4 w-4" />
                {T.resume.replace("{folder}", folder.name)}
              </Button>
            )}
            {supported && !watching && (
              <Button variant="outline" onClick={choose} data-choose-folder>
                <FolderOpen className="h-4 w-4" />
                {folder ? T.change : T.chooseFolder}
              </Button>
            )}
          </div>
          {!supported && (
            <p className="text-[12.5px] text-ink-500" data-unsupported>
              {T.unsupported}
            </p>
          )}

          {bulk && <BulkProgress bulk={bulk} />}

          {supported && watching && folder && (
            <div className="flex flex-wrap items-center gap-3 rounded-ctl border border-line px-3 py-2.5" data-watching>
              <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-st-confirmed-soft text-st-confirmed">
                <FolderOpen className="h-4.5 w-4.5" />
                <span className="absolute -end-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-st-confirmed ring-2 ring-surface" />
              </span>
              <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink-900">{T.watching.replace("{folder}", folder.name)}</span>
              <Button size="sm" variant="outline" onClick={choose}>
                {T.change}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWatching(false)}>
                {T.stop}
              </Button>
              {past.length > 0 && (
                <div className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-2.5 text-[13px] text-ink-700" data-past>
                  <span className="min-w-0 flex-1">{T.past.replace("{n}", String(past.length)).replace("{folder}", folder.name)}</span>
                  <Button
                    size="sm"
                    disabled={!!bulk && !bulk.finished}
                    onClick={() => {
                      const items = past;
                      setPast([]);
                      void sendAll(folder.name, items);
                    }}
                    data-send-past
                  >
                    <Send className="h-4 w-4" />
                    {T.sendPast}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-[15px] font-semibold text-ink-900">{T.waiting}</h2>
        {requests.length === 0 ? (
          <p className="text-[13.5px] text-ink-500">{T.nothingWaiting}</p>
        ) : (
          <ul className="grid gap-2" data-requests>
            {requests.map((r, i) => (
              <li key={r.id} className={`flex flex-wrap items-center gap-3 rounded-ctl border px-3 py-2.5 ${i === 0 ? "border-brand-300 bg-brand-50" : "border-line"}`} data-request={r.id}>
                {r.kind === "xray" ? <Radiation className="h-4.5 w-4.5 shrink-0 text-brand-700" /> : <Cable className="h-4.5 w-4.5 shrink-0 text-brand-700" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-ink-900">
                    {r.patient_name}
                    {r.teeth.length ? (
                      <>
                        {" · "}
                        <span className="tnum">{r.teeth.join(" · ")}</span>
                      </>
                    ) : r.kind === "xray" ? (
                      ` · ${T.mouth}`
                    ) : null}
                  </div>
                  <div className="text-[12.5px] text-ink-500" data-request-meta>
                    {[
                      r.device_name ?? T.anyMachine,
                      r.note ? `“${r.note}”` : null,
                      r.requested_by_name ? T.askedBy.replace("{name}", r.requested_by_name) : null,
                      new Date(r.created_at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <button type="button" onClick={() => cancel(r.id)} aria-label={T.cancelRequest} className="grid h-8 w-8 place-items-center rounded-ctl text-ink-500 hover:bg-sunken">
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink-900">
          <Inbox className="h-4.5 w-4.5 text-brand-700" />
          {T.inboxTitle}
          {inbox.length > 0 && <span className="rounded-full bg-brand-100 px-2 text-[12px] text-brand-700 tnum">{inbox.length}</span>}
        </h2>
        <p className="mb-3 mt-0.5 text-[13px] text-ink-500">{inbox.length ? T.inboxIntro : T.inboxEmpty}</p>
        {inbox.length > 0 && (
          <ul className="grid gap-2">
            {inbox.map((item) => (
              <InboxRow
                key={item.id}
                slug={slug}
                item={item}
                siblings={item.hint.folder ? inbox.filter((x) => x.id !== item.id && x.hint.folder === item.hint.folder).map((x) => x.id) : []}
                waiting={requests[0] ?? null}
                onDone={(id, requestId) => {
                  setInbox((prev) => prev.filter((x) => x.id !== id));
                  if (requestId) setRequests((prev) => prev.filter((r) => r.id !== requestId));
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink-900">{T.activity}</h2>
          <Button size="sm" variant="outline" onClick={() => handPick.current?.click()} data-send-by-hand>
            <Upload className="h-4 w-4" />
            {T.sendByHand}
          </Button>
          <input
            ref={handPick}
            type="file"
            accept="image/*,.dcm,.tif,.tiff,.pdf"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void (async () => {
                for (const f of files) await arrive(f);
              })();
            }}
          />
        </div>
        {sent.length === 0 ? (
          <p className="text-[13.5px] text-ink-500">{T.none}</p>
        ) : (
          <ul className="grid gap-1.5" data-sent>
            {sent.map((s) => (
              <li key={s.key} className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                <span className="font-semibold text-ink-900">{s.patient}</span>
                {s.teeth.length > 0 && <span className="tnum text-ink-700">· {s.teeth.join(" · ")}</span>}
                <span className="truncate text-ink-500">· {s.name}</span>
                <span className="ms-auto text-[12px] text-ink-400 tnum">{new Date(s.at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[12px] text-ink-400">{fmtDateOnly(new Date(), locale)}</p>
      </Card>

      {/* Card passes no data-* through, so the hook sits on the content. */}
      <Card className="p-4">
        <div data-station-devices>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold text-ink-900">{T.devices}</h2>
            {canManageDevices && (
              <Link href={`/c/${slug}/settings/devices`} className={buttonClass({ variant: "outline", size: "sm" })}>
                {T.manageDevices}
              </Link>
            )}
          </div>
          {devices.length === 0 ? (
            <p className="text-[13.5px] text-ink-500">{T.devicesNone}</p>
          ) : (
            <ul className="grid gap-1.5">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-[13.5px]">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${d.last_seen_at ? "bg-st-confirmed" : "bg-ink-300"}`} />
                  <span className="font-semibold text-ink-900">{d.name}</span>
                  <span className="text-ink-500" suppressHydrationWarning>
                    · {d.last_seen_at ? T.deviceSeen.replace("{t}", fmtRelative(d.last_seen_at, locale)) : T.deviceNever}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

/** A folder upload: how far it has got, then what became of every file in it. */
function BulkProgress({ bulk }: { bulk: Bulk }) {
  const { t } = useI18n();
  const T = t.station;
  const n = (s: string, v: number) => s.replace("{n}", String(v));
  if (!bulk.finished) {
    return (
      <div className="grid gap-1.5" role="status" data-bulk-progress>
        <div className="text-[13.5px] font-semibold text-ink-900 tnum">
          {bulk.total
            ? T.uploading.replace("{n}", String(bulk.done)).replace("{total}", String(bulk.total)).replace("{folder}", bulk.folder)
            : T.reading.replace("{folder}", bulk.folder)}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
          <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${bulk.total ? (bulk.done / bulk.total) * 100 : 0}%` }} />
        </div>
      </div>
    );
  }
  const parts = [
    bulk.patient ? n(T.doneFiled, bulk.patient) : null,
    bulk.inbox ? n(T.doneInbox, bulk.inbox) : null,
    bulk.before ? n(T.doneBefore, bulk.before) : null,
  ].filter(Boolean);
  return (
    <div
      className={`rounded-ctl border px-3 py-2.5 text-[13.5px] ${bulk.failed ? "border-danger/30 bg-danger-soft" : "border-line bg-sunken"}`}
      role="status"
      data-bulk-done={`${bulk.patient}/${bulk.inbox}/${bulk.before}/${bulk.failed}`}
    >
      <div className="font-semibold text-ink-900">
        {bulk.found === 0
          ? T.noResults.replace("{folder}", bulk.folder)
          : bulk.total === 0
            ? T.nothingNew.replace("{folder}", bulk.folder)
            : T.doneTitle.replace("{folder}", bulk.folder)}
      </div>
      {bulk.total > 0 && parts.length > 0 && <div className="text-ink-700 tnum">{parts.join(" · ")}</div>}
      {bulk.failed > 0 && <div className="text-danger tnum">{n(T.doneFailed, bulk.failed)}</div>}
    </div>
  );
}

/** Patients by name, phone or file number, as somebody types. */
function usePatientSearch(slug: string, q: string): Found[] {
  const [results, setResults] = useState<Found[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(q.trim())}`);
        const body = (await res.json()) as { results?: Found[] };
        setResults(body.results ?? []);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q, slug]);
  return results;
}

/**
 * An image a machine sent for nobody: shown, so a person can see whose it
 * is, with what the machine called the patient (or the folder it was
 * uploaded from); then filed or discarded. A folder named after a patient
 * usually holds only theirs, so the rest of it can go with one tap — when
 * the person says so; a folder of one day holds everybody.
 */
function InboxRow({
  slug,
  item,
  siblings,
  waiting,
  onDone,
}: {
  slug: string;
  item: InboxItem;
  /** The other items waiting from the same folder. */
  siblings: string[];
  waiting: Request | null;
  onDone: (id: string, answeredRequest?: string) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.station;
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const results = usePatientSearch(slug, q);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [together, setTogether] = useState(false);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { fileId?: string; learned?: string[] } | null;
    if (!res.ok) throw new Error("inbox");
    return json;
  };
  const file = async (patientId: string, name: string, teeth: string[] = [], requestId?: string) => {
    setBusy(true);
    try {
      const r = await post(`/api/c/${slug}/imaging/inbox/${item.id}`, { op: "file", patientId, teeth });
      // Filed to the patient a doctor is waiting on: that answers the doctor too.
      if (requestId && r?.fileId) {
        await post(`/api/c/${slug}/imaging/requests/${requestId}`, { op: "fulfil", fileId: r.fileId }).catch(() => null);
      }
      let filed = 1;
      if (together) {
        for (const id of siblings) {
          const ok = await post(`/api/c/${slug}/imaging/inbox/${id}`, { op: "file", patientId }).then(
            () => true,
            () => false
          );
          if (ok) {
            filed++;
            onDone(id);
          }
        }
      }
      // Filed by a person once: say that the machine's name for them now leads here by itself.
      toast(
        r?.learned?.length
          ? t.devices.learned.replace("{name}", r.learned[0]).replace("{patient}", name)
          : filed > 1
            ? T.filedMany.replace("{n}", String(filed)).replace("{patient}", name)
            : T.filed.replace("{patient}", name)
      );
      onDone(item.id, requestId);
    } catch {
      toast(T.failed, "error");
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      await post(`/api/c/${slug}/imaging/inbox/${item.id}`, { op: "discard" });
      toast(T.discarded);
      onDone(item.id);
    } catch {
      toast(T.failed, "error");
    } finally {
      setBusy(false);
      setDiscarding(false);
    }
  };

  const machine = item.hint.machine;
  const who = [machine?.name, machine?.id].filter(Boolean).join(" · ") || item.hint.ref;
  const what =
    [item.description || item.modality, item.study_date, item.instances > 1 ? T.images.replace("{n}", String(item.instances)) : null]
      .filter(Boolean)
      .join(" · ") || item.file_name;

  return (
    <li className="grid gap-2 rounded-ctl border border-line p-2.5" data-inbox-item={item.id}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-14 w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-night">
          {item.mime_type.startsWith("image/") && !item.mime_type.includes("tiff") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/c/${slug}/imaging/inbox/${item.id}`} alt="" className="h-full w-full object-cover" />
          ) : (
            <Radiation className="h-5 w-5 text-white/70" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-ink-900">{what}</div>
          <div className="text-[12.5px] text-ink-500">
            {item.device_name ? `${T.fromDevice.replace("{device}", item.device_name)} · ` : ""}
            {new Date(item.received_at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}
          </div>
          {who && (
            <div className="text-[12.5px] text-ink-700" data-machine-said>
              {T.machineSaid.replace("{who}", who)}
            </div>
          )}
          {item.hint.folder && (
            <div className="truncate text-[12.5px] text-ink-700" dir="auto" data-inbox-folder>
              {T.inFolder.replace("{folder}", item.hint.folder)}
            </div>
          )}
        </div>
        {waiting && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => file(waiting.patient_id, waiting.patient_name, waiting.teeth, waiting.id)}
            data-file-to-waiting
          >
            <Send className="h-4 w-4" />
            {waiting.patient_name}
          </Button>
        )}
        <button
          type="button"
          onClick={() => setDiscarding(true)}
          disabled={busy}
          aria-label={T.discard}
          className="grid h-8 w-8 place-items-center rounded-ctl text-ink-500 hover:bg-sunken"
          data-discard
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {!!item.suggestions?.length && (
        <div className="flex flex-wrap items-center gap-1.5" data-suggestions>
          <span className="text-[12.5px] font-semibold text-ink-500">{T.likely}</span>
          {item.suggestions.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => file(p.id, p.full_name)}
              className="inline-flex items-center gap-1.5 rounded-full border border-brand-300 bg-brand-50 px-3 py-1 text-[13px] font-semibold text-ink-900 hover:bg-brand-100"
              data-suggestion={p.id}
            >
              {p.full_name}
              <span className="font-normal text-ink-500 tnum">
                {p.file_no ? `#${p.file_no}` : ""}
                {p.birth_date ? ` · ${T.born.replace("{date}", p.birth_date)}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {siblings.length > 0 && item.hint.folder && (
        <label className="flex items-center gap-2 text-[13px] text-ink-700" data-inbox-together>
          <input
            type="checkbox"
            className="h-4.5 w-4.5 shrink-0 accent-brand-600"
            checked={together}
            disabled={busy}
            onChange={(e) => setTogether(e.target.checked)}
          />
          <span dir="auto">{T.alsoFolder.replace("{n}", String(siblings.length)).replace("{folder}", item.hint.folder)}</span>
        </label>
      )}
      <div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={T.search}
          aria-label={T.fileTo}
          className="h-9 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm"
          data-inbox-search
        />
        {results.length > 0 && (
          <ul className="mt-1 grid gap-1">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => file(p.id, p.full_name)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-[13.5px] hover:bg-sunken"
                  data-inbox-patient={p.id}
                >
                  <span className="font-semibold text-ink-900">
                    {p.full_name}
                    {p.file_no ? <span className="ms-2 text-[12px] font-normal text-ink-500 tnum">#{p.file_no}</span> : null}
                  </span>
                  <span dir="ltr" className="text-[12px] text-ink-500 tnum">
                    {p.phone_e164 ?? ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConfirmDialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        onConfirm={discard}
        loading={busy}
        title={T.discard}
        body={T.discardConfirm}
        confirmLabel={T.discard}
        cancelLabel={t.dental.cancel}
      />
    </li>
  );
}

