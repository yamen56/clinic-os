"use client";

/*
  The imaging station.

  Most x-ray machines hand their images to the vendor's software on the PC
  beside them, and that software saves each one into a folder. This page,
  open on that PC, watches the folder: the browser is given read access to it
  once (Chrome and Edge can; the choice is remembered on this computer), looks
  every two seconds for files that were not there before, waits until a file
  has stopped growing, and sends it.

  Where it goes is decided by the doctor at the chair. "Take x-ray" on a tooth
  leaves a request waiting here; the next image the machine saves goes into
  that patient's files, labelled with that tooth, and opens on their chart. An
  image saved with nobody waiting is held on this page — never guessed — until
  somebody sends it to a patient or dismisses it.

  Nothing is installed and no vendor software is changed. The x-ray software
  is only asked to do what it already does: save the image.
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Inbox, Radiation, Send, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { I18nProvider, useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

type Request = { id: string; patient_id: string; patient_name: string; teeth: string[]; kind: "xray" | "photo"; created_at: string; requested_by_name: string | null };
type Held = { key: string; file: File; at: number };
export type StationDevice = { id: string; name: string; kind: string; last_seen_at: string | null };
type InboxItem = {
  id: string;
  file_name: string;
  mime_type: string;
  kind: "xray" | "photo";
  teeth: string[];
  received_at: string;
  hint: { ref?: string; machine?: { id: string; name: string; birthDate: string | null }; originalName?: string };
  modality: string | null;
  description: string | null;
  study_date: string | null;
  instances: number;
  device_name: string | null;
};
type Found = { id: string; full_name: string; phone_e164: string | null; file_no?: number | null };
type Sent = { key: string; name: string; patient: string; teeth: string[]; at: number };

const IMAGE = /\.(jpe?g|png|bmp|gif|webp|tiff?|dcm)$/i;
/** DICOM exports often have no extension at all (IM0001, 1.2.840…); those are read to see. */
const BARE = /^[^.]+$|^[\d.]+$/;

/** "DICM" at byte 128 — a DICOM file, whatever it is called. */
async function isDicomFile(f: File): Promise<boolean> {
  if (f.size < 132) return false;
  try {
    return (await f.slice(128, 132).text()) === "DICM";
  } catch {
    return false;
  }
}
const SCAN_MS = 2000;

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
      if (IMAGE.test(h.name) || BARE.test(h.name)) yield { path: prefix + h.name, handle: h };
    } else if (depth < 2) {
      // Many x-ray programs file each day or each patient in a subfolder.
      yield* walk(h, `${prefix}${h.name}/`, depth + 1);
    }
  }
}

export function ImagingStation({ slug, devices, canManageDevices }: { slug: string; devices: StationDevice[]; canManageDevices: boolean }) {
  const { t } = useI18n();
  return (
    <I18nProvider dict={t} locale="en">
      <div dir="ltr" lang="en" className="font-sans" data-latin-island>
        <Station slug={slug} devices={devices} canManageDevices={canManageDevices} />
      </div>
    </I18nProvider>
  );
}

function Station({ slug, devices, canManageDevices }: { slug: string; devices: StationDevice[]; canManageDevices: boolean }) {
  const { t, locale } = useI18n();
  const T = t.dental.station;
  const { toast } = useToast();
  const [supported, setSupported] = useState(true);
  const [folder, setFolder] = useState<DirHandle | null>(null);
  const [watching, setWatching] = useState(false);
  const [requests, setRequests] = useState<Request[]>([]);
  const [held, setHeld] = useState<Held[]>([]);
  const [sent, setSent] = useState<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const requestsRef = useRef<Request[]>([]);
  requestsRef.current = requests;

  /* What the machines sent for nobody — the clinic's, not this computer's. */
  const [inbox, setInbox] = useState<InboxItem[]>([]);
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

  /* Into the patient's files, through the same route the Files tab uses; then the request is answered. */
  const send = useCallback(
    async (file: File, to: { patientId: string; patientName: string; kind: "xray" | "photo"; teeth: string[]; requestId?: string }) => {
      const fd = new FormData();
      fd.set("file", new File([file], file.name, { type: mimeOf(file), lastModified: file.lastModified }));
      fd.set("kind", to.kind);
      const res = await fetch(`/api/c/${slug}/patients/${to.patientId}/files`, { method: "POST", body: fd });
      const body = (await res.json().catch(() => null)) as { file?: { id: string } } | null;
      if (!res.ok || !body?.file) throw new Error("upload");
      if (to.requestId) {
        const r = await fetch(`/api/c/${slug}/imaging/requests/${to.requestId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "fulfil", fileId: body.file.id }),
        });
        if (!r.ok) throw new Error("fulfil");
      }
      setSent((prev) => [{ key: `${file.name}-${Date.now()}`, name: file.name, patient: to.patientName, teeth: to.teeth, at: Date.now() }, ...prev].slice(0, 30));
      toast(T.sent.replace("{patient}", to.patientName));
    },
    [slug, toast, T.sent]
  );

  /*
    A DICOM says which series it belongs to, so the server decides: a slice
    of a series already on file joins it (the rest of a CBCT, after the
    first slice answered the doctor), a new one answers whoever has waited
    longest, and one with nobody waiting goes to the clinic's inbox below.
  */
  const receiveDicom = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.set("file", new File([file], file.name, { type: "application/dicom", lastModified: file.lastModified }));
      const res = await fetch(`/api/c/${slug}/imaging/receive`, { method: "POST", body: fd });
      const body = (await res.json().catch(() => null)) as
        | { placed: "patient"; added: string; patientName: string; teeth: string[]; requestId: string | null }
        | { placed: "inbox"; added: string }
        | null;
      if (!res.ok || !body) throw new Error("upload");
      if (body.placed === "inbox") {
        if (body.added === "new") toast(T.toInbox);
        void loadInbox();
        return;
      }
      if (body.requestId) setRequests((prev) => prev.filter((r) => r.id !== body.requestId));
      setSent((prev) => [{ key: `${file.name}-${Date.now()}`, name: file.name, patient: body.patientName, teeth: body.teeth, at: Date.now() }, ...prev].slice(0, 30));
      if (body.added === "new") toast(T.sent.replace("{patient}", body.patientName));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, toast, T.toInbox, T.sent]
  );

  /* A new image: to whoever has been waiting longest, or held if nobody is. */
  const arrive = useCallback(
    async (file: File) => {
      if (await isDicomFile(file)) {
        try {
          await receiveDicom(file);
        } catch {
          toast(T.failed, "error");
          setHeld((prev) => [...prev, { key: `${file.name}-${file.lastModified}-${file.size}`, file, at: Date.now() }]);
        }
        void poll();
        return;
      }
      // A file with no extension that is not DICOM is not an image at all.
      if (!IMAGE.test(file.name)) return;
      const req = requestsRef.current[0];
      if (!req) {
        setHeld((prev) => [...prev, { key: `${file.name}-${file.lastModified}-${file.size}`, file, at: Date.now() }]);
        return;
      }
      setRequests((prev) => prev.filter((r) => r.id !== req.id));
      try {
        await send(file, { patientId: req.patient_id, patientName: req.patient_name, kind: req.kind, teeth: req.teeth, requestId: req.id });
      } catch {
        toast(T.failed, "error");
        setHeld((prev) => [...prev, { key: `${file.name}-${file.lastModified}-${file.size}`, file, at: Date.now() }]);
      }
      void poll();
    },
    [send, poll, toast, T.failed, receiveDicom]
  );

  /*
    Watching: everything in the folder when watching starts is the past and is
    left alone. A file that appears is sent once it has been the same size on
    two looks in a row — an x-ray program writes a large file in pieces, and a
    half-written image is no use to anybody.
  */
  const seen = useRef<Set<string>>(new Set());
  const growing = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!folder || !watching) return;
    let stop = false;
    let first = true;
    const look = async () => {
      try {
        for await (const { path, handle } of walk(folder)) {
          if (stop) return;
          if (seen.current.has(path)) continue;
          const f = await handle.getFile();
          if (first) {
            seen.current.add(path);
            continue;
          }
          const before = growing.current.get(path);
          if (before === f.size && f.size > 0) {
            seen.current.add(path);
            growing.current.delete(path);
            void arrive(f);
          } else {
            growing.current.set(path, f.size);
          }
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
    };
  }, [folder, watching, arrive]);

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
          <Radiation className="h-6 w-6 text-brand-600" />
          {T.title}
        </h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-700">{T.intro}</p>
      </div>

      <Card className="p-4">
        {!supported ? (
          <p className="text-[13.5px] text-ink-700" data-unsupported>
            {T.unsupported}
          </p>
        ) : watching && folder ? (
          <div className="flex flex-wrap items-center gap-3" data-watching>
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
          </div>
        ) : folder ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={resume}>
              <FolderOpen className="h-4 w-4" />
              {T.resume.replace("{folder}", folder.name)}
            </Button>
            <Button variant="outline" onClick={choose}>
              {T.change}
            </Button>
          </div>
        ) : (
          <Button onClick={choose} data-choose-folder>
            <FolderOpen className="h-4 w-4" />
            {T.chooseFolder}
          </Button>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-[15px] font-semibold text-ink-900">{T.waiting}</h2>
        {requests.length === 0 ? (
          <p className="text-[13.5px] text-ink-500">{T.nothingWaiting}</p>
        ) : (
          <ul className="grid gap-2" data-requests>
            {requests.map((r, i) => (
              <li key={r.id} className={`flex flex-wrap items-center gap-3 rounded-ctl border px-3 py-2.5 ${i === 0 ? "border-brand-300 bg-brand-50" : "border-line"}`} data-request={r.id}>
                <Radiation className="h-4.5 w-4.5 shrink-0 text-brand-600" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-ink-900">
                    {r.patient_name} · <span className="tnum">{r.teeth.length ? r.teeth.join(" · ") : T.mouth}</span>
                  </div>
                  <div className="text-[12.5px] text-ink-500">
                    {r.requested_by_name ? T.askedBy.replace("{name}", r.requested_by_name) : ""} · {new Date(r.created_at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}
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

      {held.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-3 text-[15px] font-semibold text-ink-900">{T.held}</h2>
          <ul className="grid gap-2" data-held>
            {held.map((h) => (
              <HeldRow
                key={h.key}
                slug={slug}
                item={h}
                busy={busy}
                waiting={requests[0] ?? null}
                onSend={async (to) => {
                  setBusy(true);
                  try {
                    await send(h.file, to);
                    setHeld((prev) => prev.filter((x) => x.key !== h.key));
                    if (to.requestId) setRequests((prev) => prev.filter((r) => r.id !== to.requestId));
                  } catch {
                    toast(T.failed, "error");
                  } finally {
                    setBusy(false);
                  }
                }}
                onDismiss={() => setHeld((prev) => prev.filter((x) => x.key !== h.key))}
              />
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink-900">
          <Inbox className="h-4.5 w-4.5 text-brand-600" />
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
            accept="image/*,.dcm,.tif,.tiff"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void arrive(f);
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
 * is, with what the machine called the patient; then filed or discarded.
 */
function InboxRow({
  slug,
  item,
  waiting,
  onDone,
}: {
  slug: string;
  item: InboxItem;
  waiting: Request | null;
  onDone: (id: string, answeredRequest?: string) => void;
}) {
  const { t, locale } = useI18n();
  const T = t.dental.station;
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const results = usePatientSearch(slug, q);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { fileId?: string } | null;
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
      toast(T.filed.replace("{patient}", name));
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
        <span className="grid h-14 w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-ink-900">
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

/** An image nobody asked for: to the request now waiting, to a patient found by search, or away. */
function HeldRow({
  slug,
  item,
  busy,
  waiting,
  onSend,
  onDismiss,
}: {
  slug: string;
  item: Held;
  busy: boolean;
  waiting: Request | null;
  onSend: (to: { patientId: string; patientName: string; kind: "xray" | "photo"; teeth: string[]; requestId?: string }) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const T = t.dental.station;
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string; phone_e164: string | null }[]>([]);
  const [url] = useState(() => (item.file.type.startsWith("image/") && !/tiff/.test(item.file.type) ? URL.createObjectURL(item.file) : null));
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(q.trim())}`);
        const body = (await res.json()) as { results?: { id: string; full_name: string; phone_e164: string | null }[] };
        setResults(body.results ?? []);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q, slug]);

  return (
    <li className="grid gap-2 rounded-ctl border border-line p-2.5">
      <div className="flex items-center gap-3">
        <span className="grid h-14 w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-ink-900">
          {
            // eslint-disable-next-line @next/next/no-img-element
            url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <Radiation className="h-5 w-5 text-white/70" />
          }
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-900">{item.file.name}</span>
        {waiting && (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onSend({ patientId: waiting.patient_id, patientName: waiting.patient_name, kind: waiting.kind, teeth: waiting.teeth, requestId: waiting.id })}
          >
            <Send className="h-4 w-4" />
            {waiting.patient_name}
          </Button>
        )}
        <button type="button" onClick={onDismiss} aria-label={T.dismiss} className="grid h-8 w-8 place-items-center rounded-ctl text-ink-500 hover:bg-sunken">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={T.search}
          aria-label={T.sendTo}
          className="h-9 w-full rounded-ctl border border-line bg-surface px-3 text-base md:text-sm"
        />
        {results.length > 0 && (
          <ul className="mt-1 grid gap-1">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSend({ patientId: p.id, patientName: p.full_name, kind: "xray", teeth: [] })}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-[13.5px] hover:bg-sunken"
                >
                  <span className="font-semibold text-ink-900">{p.full_name}</span>
                  <span dir="ltr" className="text-[12px] text-ink-500 tnum">
                    {p.phone_e164 ?? ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
