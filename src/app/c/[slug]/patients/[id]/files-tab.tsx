"use client";

/*
  The patient's Files: everything the clinic and its machines have of them,
  in one place, read the way it is used.

  - A gallery, not a list of names: pictures as pictures, every result marked
    with what it is (x-ray, ECG, ultrasound, report…), when, and which
    machine sent it. Filters by kind, in the order the clinic's specialties
    use (lib/specialty-profile).
  - One viewer for every picture, the same as the dental chart's: zoom,
    exposure, compare two side by side, send to the patient on WhatsApp.
  - The machines, from here: "Take photo" uses the camera on this computer;
    results a machine sent without saying whose, that look like this
    patient's, can be filed from here in one tap. "Request from device" (ask a
    machine for the next result) was taken out on 2026-11-02 — Yamen: "it is
    not functional".
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Copy, Download, FileText, FolderUp, Smile, Trash2, Upload, X } from "lucide-react";
import { folderItems, resultsIn } from "@/lib/imaging/folder-files";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate } from "@/lib/dates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/modal";
import { Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ImageViewer, type ChartImage } from "@/components/charts/dental/image-viewer";
import { FILE_VIEWS } from "@/lib/imaging/kinds";
import { CameraCapture } from "@/components/charts/dental/camera-capture";
import { SendToPatient, sendPictureToPatient } from "@/components/patient-files/send-to-patient";
import { deletePatientFileAction } from "../actions";
import type { PatientFileRow } from "./profile-client";

export type FilesHub = {
  devices: { id: string; name: string; kind: string }[];
  likely: {
    id: string;
    file_name: string;
    mime_type: string;
    kind: string;
    received_at: string;
    device: string | null;
    machine: { name?: string; birthDate?: string | null } | null;
    /** The folder it was uploaded from, when that is what named the patient. */
    folder?: string | null;
  }[];
  /** What the clinic's machines call this patient — learned when somebody filed one of their pictures. */
  links: { id: string; label: string; key: string }[];
  /** Result kinds the clinic's specialties keep, in their order. */
  kinds: string[];
  canMessage: boolean;
  canManageDevices: boolean;
  clinicName: string;
};

const isPicture = (mime: string) => /^image\/(png|jpe?g|webp|gif|bmp)$/.test(mime);

export function FilesTab({
  slug,
  patientId,
  patientName,
  fileNo,
  files,
  tz,
  hub,
  dental,
}: {
  slug: string;
  patientId: string;
  patientName: string;
  /** Their Clinicti number: "CLN-<n>" given to them on a machine's software finds them by itself. */
  fileNo: number | null;
  files: PatientFileRow[];
  tz: string;
  hub: FilesHub | null;
  /** The clinic charts teeth: pictures can be pinned to teeth (if this member may record). */
  dental: { canPin: boolean } | null;
}) {
  const { t, locale } = useI18n();
  const T = t.devices;
  const router = useRouter();
  const { toast } = useToast();
  const kindLabel = (k: string) => (t.patients.files.kinds as Record<string, string>)[k] ?? k;

  const [uploadKind, setUploadKind] = useState("other");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  /** Within x-rays: panoramics, bitewings… (2026-11-02). */
  const [viewFilter, setViewFilter] = useState<string>("all");
  /** The picture open in the viewer — by id, so a copy saved in front of it does not shift it. */
  const [viewerId, setViewerId] = useState<string | null>(null);
  /** Copies saved from the viewer, until the page's own list has them. */
  const [added, setAdded] = useState<PatientFileRow[]>([]);
  const [views, setViews] = useState<Record<string, string | null>>(() => Object.fromEntries(files.map((f) => [f.id, f.view ?? null])));
  useEffect(() => setViews((prev) => ({ ...prev, ...Object.fromEntries(files.map((f) => [f.id, f.view ?? null])) })), [files]);
  const [camera, setCamera] = useState(false);
  const [likely, setLikely] = useState(hub?.likely ?? []);
  const [links, setLinks] = useState(hub?.links ?? []);
  useEffect(() => setLinks(hub?.links ?? []), [hub?.links]);
  // Clinics whose machines send results: where telling a machine who the patient is matters.
  const machines = !!hub && (hub.devices.length > 0 || links.length > 0 || hub.kinds.some((k) => ["xray", "ecg", "ultrasound", "scan"].includes(k)));
  const machineId = fileNo != null ? `CLN-${fileNo}` : null;
  const [teeth, setTeeth] = useState<Record<string, string[]>>(() => Object.fromEntries(files.map((f) => [f.id, f.teeth ?? []])));
  const [sending, setSending] = useState<{ img: ChartImage; caption: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => setTeeth((prev) => ({ ...prev, ...Object.fromEntries(files.map((f) => [f.id, f.teeth ?? []])) })), [files]);
  const allFiles = useMemo(() => [...added.filter((a) => !files.some((f) => f.id === a.id)), ...files], [added, files]);
  const viewLabels = t.viewer.views as Record<string, string>;

  // The clinic's kinds first, then whatever else this patient has; only kinds that have files.
  const kinds = useMemo(() => {
    const present = new Set(allFiles.map((f) => f.kind));
    const order = [...(hub?.kinds ?? []), ...allFiles.map((f) => f.kind)];
    return order.filter((k, i) => present.has(k) && order.indexOf(k) === i && k !== "insurance_card");
  }, [allFiles, hub?.kinds]);
  const ofKind = useMemo(() => (filter === "all" ? allFiles : allFiles.filter((f) => f.kind === filter)), [allFiles, filter]);
  // The views among the x-rays (or photos) shown, for the second row of filters.
  const presentViews = useMemo(() => FILE_VIEWS.filter((v) => ofKind.some((f) => views[f.id] === v)), [ofKind, views]);
  const shown = useMemo(
    () => (viewFilter === "all" || filter === "all" ? ofKind : ofKind.filter((f) => views[f.id] === viewFilter)),
    [ofKind, viewFilter, filter, views]
  );
  const pictures = useMemo(() => shown.filter((f) => isPicture(f.mime_type)), [shown]);
  const images: ChartImage[] = useMemo(
    () =>
      pictures.map((f) => ({
        id: f.id,
        src: `/api/c/${slug}/files/${f.id}`,
        name: f.file_name,
        kind: f.kind,
        view: views[f.id] ?? null,
        mime: f.mime_type,
        date: f.created_at,
      })),
    [pictures, slug, views]
  );
  const viewer = viewerId ? images.findIndex((x) => x.id === viewerId) : -1;

  /* What a picture shows, set from the viewer; taken back if the save fails. */
  const setView = async (fileId: string, view: string | null) => {
    const before = views[fileId] ?? null;
    setViews((prev) => ({ ...prev, [fileId]: view }));
    const res = await fetch(`/api/c/${slug}/files/${fileId}/view`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view }),
    }).catch(() => null);
    if (!res?.ok) {
      setViews((prev) => ({ ...prev, [fileId]: before }));
      return toast(t.common.genericError, "error");
    }
    router.refresh();
  };

  /* An edited picture, saved beside its original, with its view and teeth; the viewer moves on to it. */
  const saveCopy = async (orig: ChartImage, file: File): Promise<ChartImage | null> => {
    const fd = new FormData();
    fd.set("file", file);
    fd.set("kind", orig.kind);
    if (orig.view) fd.set("view", orig.view);
    fd.set("teeth", (teeth[orig.id] ?? []).join(","));
    fd.set("editedFrom", orig.id);
    const res = await fetch(`/api/c/${slug}/patients/${patientId}/files`, { method: "POST", body: fd }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { file?: PatientFileRow } | null;
    if (!res?.ok || !body?.file) {
      toast(t.viewer.saveFailed, "error");
      return null;
    }
    const row = body.file;
    setAdded((prev) => [row, ...prev]);
    setTeeth((prev) => ({ ...prev, [row.id]: row.teeth ?? [] }));
    setViews((prev) => ({ ...prev, [row.id]: row.view ?? null }));
    setViewerId(row.id);
    toast(t.viewer.savedCopy);
    router.refresh();
    return { id: row.id, src: `/api/c/${slug}/files/${row.id}`, name: row.file_name, kind: row.kind, view: row.view ?? null, mime: row.mime_type, date: row.created_at };
  };

  /* "view:panoramic" in the upload menu is an x-ray of that view. */
  const upload = async (list: File[], choice: string) => {
    const view = choice.startsWith("view:") ? choice.slice(5) : null;
    const kind = view ? (view === "intraoral" ? "photo" : "xray") : choice;
    if (!list.length) return;
    setUploading(true);
    setProgress(list.length > 1 ? { done: 0, total: list.length } : null);
    // A folder is many files: one word about what went wrong, not one per file.
    let tooLarge = 0;
    let failed = 0;
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("kind", kind);
        if (view) fd.set("view", view);
        const res = await fetch(`/api/c/${slug}/patients/${patientId}/files`, { method: "POST", body: fd }).catch(() => null);
        if (res?.status === 413) tooLarge++;
        else if (!res?.ok) failed++;
        setProgress((p) => p && { ...p, done: p.done + 1 });
      }
      if (list.length === 1 && tooLarge) toast(t.patients.files.tooLarge, "error");
      else if (list.length === 1 && failed) toast(t.common.genericError, "error");
      else if (tooLarge + failed) toast(t.patients.files.someFailed.replace("{n}", String(tooLarge + failed)), "error");
      router.refresh();
    } finally {
      setUploading(false);
      setProgress(null);
    }
  };

  /* A folder — a CD or USB from the x-ray machine: its pictures, scans and reports, never the viewer program beside them. */
  const uploadFolder = async (picked: FileList | null) => {
    const items = await resultsIn(folderItems(picked));
    if (!items.length) return toast(t.patients.files.noneInFolder, "error");
    await upload(
      items.map((i) => i.file),
      uploadKind
    );
  };

  const fileLikely = async (id: string) => {
    const res = await fetch(`/api/c/${slug}/imaging/inbox/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "file", patientId }),
    });
    if (!res.ok) return toast(t.common.genericError, "error");
    const body = (await res.json().catch(() => null)) as { learned?: string[] } | null;
    setLikely((prev) => prev.filter((l) => l.id !== id));
    if (body?.learned?.length) toast(T.learned.replace("{name}", body.learned[0]).replace("{patient}", patientName));
    router.refresh();
  };

  const forget = async (link: FilesHub["links"][number]) => {
    setLinks((prev) => prev.filter((l) => l.id !== link.id));
    const res = await fetch(`/api/c/${slug}/imaging/links/${link.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setLinks((prev) => [...prev, link]);
      return toast(t.common.genericError, "error");
    }
    toast(T.forgotten.replace("{name}", link.label));
  };

  const pin = useCallback(
    async (fileId: string, fdi: string) => {
      const cur = teeth[fileId] ?? [];
      const next = cur.includes(fdi) ? cur.filter((x) => x !== fdi) : [...cur, fdi].sort();
      setTeeth((prev) => ({ ...prev, [fileId]: next }));
      const res = await fetch(`/api/c/${slug}/files/${fileId}/teeth`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teeth: next }),
      }).catch(() => null);
      if (!res?.ok) {
        setTeeth((prev) => ({ ...prev, [fileId]: cur }));
        toast(t.common.genericError, "error");
      }
    },
    [teeth, slug, toast, t.common.genericError]
  );

  return (
    <div className="grid gap-4" data-files-hub>
      {/* Ways in: upload, the camera here, a machine. */}
      <Card className="p-4">
        <div
          className="flex flex-wrap items-center gap-2.5"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(Array.from(e.dataTransfer.files), uploadKind);
          }}
        >
          <Select value={uploadKind} onChange={(e) => setUploadKind(e.target.value)} className="!w-auto" aria-label={t.patients.files.upload}>
            {[...new Set([...(hub?.kinds ?? []), ...Object.keys(t.patients.files.kinds)])].map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
            {/* A dental clinic files its x-rays by what they show. */}
            {dental && (
              <optgroup label={kindLabel("xray")}>
                {FILE_VIEWS.map((v) => (
                  <option key={v} value={`view:${v}`}>
                    {viewLabels[v]}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void upload(Array.from(e.target.files ?? []), uploadKind);
              e.target.value = "";
            }}
          />
          <Button loading={uploading} onClick={() => fileInput.current?.click()}>
            <Upload className="h-4 w-4" />
            {progress ? t.patients.files.uploadingOf.replace("{n}", String(progress.done)).replace("{total}", String(progress.total)) : t.patients.files.upload}
          </Button>
          <input
            ref={folderInput}
            // Not in React's types; every browser takes it. In the HTML, so it holds before hydration too.
            {...{ webkitdirectory: "" }}
            type="file"
            multiple
            className="hidden"
            data-patient-folder-input
            onChange={(e) => {
              void uploadFolder(e.target.files);
              e.target.value = "";
            }}
          />
          <Button variant="outline" disabled={uploading} onClick={() => folderInput.current?.click()} data-patient-upload-folder>
            <FolderUp className="h-4 w-4" />
            {t.patients.files.uploadFolder}
          </Button>
          <Button variant="outline" onClick={() => setCamera(true)} data-take-photo>
            <Camera className="h-4 w-4" />
            {T.takePhoto}
          </Button>
          <span className="text-[13px] text-ink-400">{t.patients.files.dropHint}</span>
        </div>

        {/* Who this patient is on the machine: the number to give them there, and the names it has already been taught. */}
        {machines && (machineId || links.length > 0) && (
          <div className="mt-3 grid gap-2 border-t border-line pt-3 text-[13px] text-ink-700" data-machine-id={machineId ?? ""}>
            {machineId && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{T.machineIdIntro}</span>
                <button
                  type="button"
                  dir="ltr"
                  onClick={() =>
                    navigator.clipboard?.writeText(machineId).then(
                      () => toast(t.common.copied),
                      () => toast(t.common.genericError, "error")
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2 py-0.5 font-semibold text-ink-900 tnum hover:bg-line"
                  aria-label={`${t.common.copy} ${machineId}`}
                  data-machine-id-copy
                >
                  {machineId}
                  <Copy className="h-3.5 w-3.5 text-ink-500" />
                </button>
                <span className="text-ink-500">{T.machineIdHint}</span>
              </div>
            )}
            {links.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5" data-machine-links>
                <span className="text-ink-500">{T.knownAs}</span>
                {links.map((l) => (
                  <span
                    key={l.id}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pe-1 ps-2.5 text-[12.5px] font-semibold text-ink-900"
                    data-machine-link={l.id}
                  >
                    <span dir="auto">{l.key.startsWith("id:") ? T.machinePatientId.replace("{id}", l.label) : l.label}</span>
                    <button
                      type="button"
                      onClick={() => forget(l)}
                      aria-label={`${T.forgetLink}: ${l.label}`}
                      className="grid h-5 w-5 place-items-center rounded-full text-ink-500 hover:bg-sunken hover:text-ink-900"
                      data-forget-link
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Results a machine sent for nobody, that look like this patient's. */}
      {likely.length > 0 && (
        <Card className="p-4">
          <div data-likely-section>
          <h3 className="font-display text-[15px] font-semibold text-ink-900">{T.likelyTitle}</h3>
          <p className="mb-3 mt-0.5 text-[13px] text-ink-500">{T.likelyBody}</p>
          <ul className="grid gap-2">
            {likely.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-ctl border border-line p-2.5" data-likely={l.id}>
                <span className="grid h-12 w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-night">
                  {isPicture(l.mime_type) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/c/${slug}/imaging/inbox/${l.id}`} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <FileText className="h-5 w-5 text-white/70" />
                  )}
                </span>
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="truncate font-semibold text-ink-900">{l.file_name}</div>
                  <div className="text-ink-500">
                    {kindLabel(l.kind)}
                    {l.device ? ` · ${l.device}` : ""} · {fmtDate(l.received_at, tz, locale)}
                    {l.machine?.name ? ` · ${l.machine.name}` : ""}
                    {l.machine?.birthDate ? ` · ${l.machine.birthDate}` : ""}
                    {!l.machine?.name && l.folder ? ` · ${t.station.inFolder.replace("{folder}", l.folder)}` : ""}
                  </div>
                </div>
                <Button size="sm" onClick={() => fileLikely(l.id)} data-likely-file>
                  {T.fileHere}
                </Button>
              </li>
            ))}
          </ul>
          </div>
        </Card>
      )}

      {kinds.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="tablist" data-files-filters>
          {["all", ...kinds].map((k) => {
            const n = k === "all" ? allFiles.length : allFiles.filter((f) => f.kind === k).length;
            const on = filter === k;
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setFilter(k);
                  setViewFilter("all");
                }}
                className={`rounded-full px-3 py-1 text-[13px] font-semibold transition-colors ${on ? "bg-ink-900 text-surface" : "bg-surface text-ink-700 ring-1 ring-line hover:bg-sunken"}`}
                data-files-filter={k}
              >
                {k === "all" ? T.allKinds : kindLabel(k)} <span className="tnum opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* Within the x-rays: panoramics, bitewings, periapicals… */}
      {filter !== "all" && presentViews.length > 0 && (
        <div className="-mt-2 flex flex-wrap gap-1.5" data-files-views>
          {["all", ...presentViews].map((v) => {
            const on = viewFilter === v;
            const n = v === "all" ? ofKind.length : ofKind.filter((f) => views[f.id] === v).length;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setViewFilter(v)}
                aria-pressed={on}
                className={`rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold transition-colors ${on ? "bg-brand-600 text-on-brand" : "bg-sunken text-ink-700 hover:bg-line"}`}
                data-files-view={v}
              >
                {v === "all" ? T.allKinds : viewLabels[v]} <span className="tnum opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {shown.length === 0 ? (
        <EmptyState icon={<FileText />} title={t.patients.files.empty} body={t.patients.files.emptyBody} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((f) => {
            const picture = isPicture(f.mime_type);
            const open = () => (picture ? setViewerId(f.id) : window.open(`/api/c/${slug}/files/${f.id}`, "_blank", "noopener"));
            const fileView = views[f.id];
            const fileTeeth = teeth[f.id] ?? [];
            return (
              <Card key={f.id} className="group overflow-hidden">
                <div data-file-tile={f.id} data-file-kind={f.kind}>
                  <button type="button" onClick={open} className="relative block aspect-[4/3] w-full overflow-hidden bg-night text-start" aria-label={f.file_name}>
                    {picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/c/${slug}/files/${f.id}?thumb=1`} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-220 group-hover:scale-[1.03]" />
                    ) : (
                      <span className="grid h-full w-full place-items-center bg-brand-50 text-brand-700">
                        <FileText className="h-9 w-9" />
                      </span>
                    )}
                    <span className="absolute start-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white" data-file-label>
                      {(fileView && viewLabels[fileView]) || kindLabel(f.kind)}
                    </span>
                    {f.edited_from && (
                      <span className="absolute end-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-ink-900" data-file-edited>
                        {t.viewer.editedSuffix}
                      </span>
                    )}
                    {fileTeeth.length > 0 && (
                      <span dir="ltr" className="absolute bottom-2 start-2 inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-brand-700 tnum" data-file-teeth>
                        <Smile className="h-3 w-3" />
                        {fileTeeth.join(" · ")}
                      </span>
                    )}
                  </button>
                  <div className="flex items-start gap-1.5 p-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink-900">{f.file_name}</div>
                      <div className="truncate text-[11.5px] text-ink-500">
                        {fmtDate(f.created_at, tz, locale)}
                        {f.device_name ? (
                          <span data-file-device> · {T.fromDevice.replace("{device}", f.device_name)}</span>
                        ) : null}
                      </div>
                      {f.dicom && (
                        <a
                          href={`/api/c/${slug}/files/${f.id}/dicom`}
                          className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-700 hover:underline"
                          data-file-dicom={f.dicom.instances}
                        >
                          <Download className="h-3 w-3" />
                          {f.dicom.instances > 1 ? T.dicomImages.replace("{n}", String(f.dicom.instances)) : T.dicomOriginal}
                        </a>
                      )}
                    </div>
                    <button onClick={() => setDeleteId(f.id)} className="text-ink-300 transition-colors hover:text-danger" aria-label={t.common.delete}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {viewer >= 0 && images[viewer] && (
        <ImageViewer
          images={images}
          index={viewer}
          pins={teeth}
          canPin={!!dental?.canPin}
          showTeeth={!!dental}
          onIndex={(i) => setViewerId(images[i]?.id ?? null)}
          onPin={pin}
          onClose={() => setViewerId(null)}
          onView={dental ? (id, v) => void setView(id, v) : undefined}
          onSaveCopy={saveCopy}
          onSend={
            hub?.canMessage
              ? (img) =>
                  setSending({
                    img,
                    caption: (img.kind === "xray" ? t.devices.xrayCaption : t.devices.resultCaption)
                      .replace("{clinic}", hub.clinicName)
                      .replace("{date}", fmtDate(img.date, tz, locale)),
                  })
              : undefined
          }
        />
      )}

      {sending && (
        <SendToPatient
          img={sending.img}
          initialCaption={sending.caption}
          onClose={() => setSending(null)}
          onSend={async (text) => {
            const r = await sendPictureToPatient(slug, sending.img.id, text);
            if (r === "ok") {
              toast(t.viewer.sentWhatsApp);
              setSending(null);
            } else {
              toast(r === "no_phone" ? t.viewer.sendNoPhone : r === "whatsapp_not_connected" ? t.viewer.sendNoWhatsApp : t.viewer.sendFailed, "error");
            }
          }}
        />
      )}

      <CameraCapture open={camera} onClose={() => setCamera(false)} onPhoto={(f) => void upload([f], "photo").then(() => setCamera(false))} />

      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t.common.confirmDeleteTitle}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={async () => {
          if (deleteId) {
            await deletePatientFileAction(slug, deleteId);
            toast(t.patients.files.deleted);
            setDeleteId(null);
            router.refresh();
          }
        }}
      />
    </div>
  );
}
