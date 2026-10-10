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
  - The machines, from here: "Request from device" asks a machine for this
    patient's next result and shows it waiting until it arrives; "Take photo"
    uses the camera on this computer; results a machine sent without saying
    whose, that look like this patient's, can be filed from here in one tap.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, Download, FileText, LoaderCircle, Radio, Smile, Trash2, Upload, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate, fmtRelative } from "@/lib/dates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { ImageViewer, type ChartImage } from "@/components/charts/dental/image-viewer";
import { CameraCapture } from "@/components/charts/dental/camera-capture";
import { SendToPatient, sendPictureToPatient } from "@/components/patient-files/send-to-patient";
import { deletePatientFileAction } from "../actions";
import type { PatientFileRow } from "./profile-client";

export type FilesHub = {
  devices: { id: string; name: string; kind: string }[];
  waiting: { id: string; kind: string; note: string; device: string | null; createdAt: string; teeth: string[] }[];
  likely: {
    id: string;
    file_name: string;
    mime_type: string;
    kind: string;
    received_at: string;
    device: string | null;
    machine: { name?: string; birthDate?: string | null } | null;
  }[];
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
  files,
  tz,
  hub,
  dental,
}: {
  slug: string;
  patientId: string;
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
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [viewer, setViewer] = useState<number | null>(null);
  const [camera, setCamera] = useState(false);
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(hub?.waiting ?? []);
  const [likely, setLikely] = useState(hub?.likely ?? []);
  const [teeth, setTeeth] = useState<Record<string, string[]>>(() => Object.fromEntries(files.map((f) => [f.id, f.teeth ?? []])));
  const [sending, setSending] = useState<{ img: ChartImage; caption: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => setTeeth(Object.fromEntries(files.map((f) => [f.id, f.teeth ?? []]))), [files]);

  // The clinic's kinds first, then whatever else this patient has; only kinds that have files.
  const kinds = useMemo(() => {
    const present = new Set(files.map((f) => f.kind));
    const order = [...(hub?.kinds ?? []), ...files.map((f) => f.kind)];
    return order.filter((k, i) => present.has(k) && order.indexOf(k) === i && k !== "insurance_card");
  }, [files, hub?.kinds]);
  const shown = useMemo(() => (filter === "all" ? files : files.filter((f) => f.kind === filter)), [files, filter]);
  const pictures = useMemo(() => shown.filter((f) => isPicture(f.mime_type)), [shown]);
  const images: ChartImage[] = useMemo(
    () => pictures.map((f) => ({ id: f.id, src: `/api/c/${slug}/files/${f.id}`, name: f.file_name, kind: f.kind, mime: f.mime_type, date: f.created_at })),
    [pictures, slug]
  );

  const upload = async (list: File[], kind: string) => {
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list) {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("kind", kind);
        const res = await fetch(`/api/c/${slug}/patients/${patientId}/files`, { method: "POST", body: fd });
        if (res.status === 413) toast(t.patients.files.tooLarge, "error");
        else if (!res.ok) toast(t.common.genericError, "error");
      }
      router.refresh();
    } finally {
      setUploading(false);
    }
  };

  // Waiting on a machine: the result shows up here by itself.
  const watchIds = waiting.map((w) => w.id).join();
  useEffect(() => {
    if (!watchIds) return;
    let stop = false;
    const look = async () => {
      for (const id of watchIds.split(",")) {
        try {
          const res = await fetch(`/api/c/${slug}/imaging/requests/${id}`, { cache: "no-store" });
          const body = (await res.json()) as { request?: { fulfilledAt: string | null; cancelledAt: string | null }; file?: { file_name: string } | null };
          if (stop || !body.request) continue;
          if (body.request.fulfilledAt || body.request.cancelledAt) {
            setWaiting((prev) => prev.filter((w) => w.id !== id));
            if (body.request.fulfilledAt) {
              toast(T.arrived.replace("{name}", body.file?.file_name ?? ""));
              router.refresh();
            }
          }
        } catch {
          // the next look
        }
      }
    };
    const timer = setInterval(look, 2500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [watchIds, slug, router, toast, T.arrived]);

  const cancelWait = async (id: string) => {
    setWaiting((prev) => prev.filter((w) => w.id !== id));
    await fetch(`/api/c/${slug}/imaging/requests/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "cancel" }) }).catch(() => null);
  };

  const fileLikely = async (id: string) => {
    const res = await fetch(`/api/c/${slug}/imaging/inbox/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "file", patientId }),
    });
    if (!res.ok) return toast(t.common.genericError, "error");
    setLikely((prev) => prev.filter((l) => l.id !== id));
    router.refresh();
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
            {t.patients.files.upload}
          </Button>
          <Button variant="outline" onClick={() => setCamera(true)} data-take-photo>
            <Camera className="h-4 w-4" />
            {T.takePhoto}
          </Button>
          {hub && (
            <Button variant="outline" onClick={() => setAsking(true)} data-request-device>
              <Radio className="h-4 w-4" />
              {T.request}
            </Button>
          )}
          <span className="text-[13px] text-ink-400">{t.patients.files.dropHint}</span>
        </div>

        {waiting.length > 0 && (
          <ul className="mt-3 grid gap-2">
            {waiting.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2.5 rounded-ctl border border-brand-300 bg-brand-50 px-3 py-2 text-[13.5px]" data-waiting-request={w.id}>
                <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-brand-600" />
                <span className="font-semibold text-ink-900">
                  {w.device ? T.waitingFor.replace("{device}", w.device) : T.waitingAny}
                  {w.note ? ` · ${w.note}` : ""}
                  {w.teeth.length ? ` · ${w.teeth.join(" ")}` : ""}
                </span>
                <span className="text-ink-500" suppressHydrationWarning>
                  {T.waitingSince.replace("{t}", fmtRelative(w.createdAt, locale))}
                </span>
                <button type="button" onClick={() => cancelWait(w.id)} className="ms-auto grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-white" aria-label={t.common.cancel}>
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
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
                <span className="grid h-12 w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-ink-900">
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
            const n = k === "all" ? files.length : files.filter((f) => f.kind === k).length;
            const on = filter === k;
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(k)}
                className={`rounded-full px-3 py-1 text-[13px] font-semibold transition-colors ${on ? "bg-ink-900 text-white" : "bg-surface text-ink-700 ring-1 ring-line hover:bg-sunken"}`}
                data-files-filter={k}
              >
                {k === "all" ? T.allKinds : kindLabel(k)} <span className="tnum opacity-70">{n}</span>
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
            const open = () => (picture ? setViewer(pictures.findIndex((p) => p.id === f.id)) : window.open(`/api/c/${slug}/files/${f.id}`, "_blank", "noopener"));
            const fileTeeth = teeth[f.id] ?? [];
            return (
              <Card key={f.id} className="group overflow-hidden">
                <div data-file-tile={f.id} data-file-kind={f.kind}>
                  <button type="button" onClick={open} className="relative block aspect-[4/3] w-full overflow-hidden bg-ink-900 text-start" aria-label={f.file_name}>
                    {picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/c/${slug}/files/${f.id}?thumb=1`} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-220 group-hover:scale-[1.03]" />
                    ) : (
                      <span className="grid h-full w-full place-items-center bg-brand-50 text-brand-600">
                        <FileText className="h-9 w-9" />
                      </span>
                    )}
                    <span className="absolute start-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">{kindLabel(f.kind)}</span>
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

      {viewer !== null && images[viewer] && (
        <ImageViewer
          images={images}
          index={viewer}
          pins={teeth}
          canPin={!!dental?.canPin}
          showTeeth={!!dental}
          onIndex={setViewer}
          onPin={pin}
          onClose={() => setViewer(null)}
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

      {asking && hub && (
        <RequestFromDevice
          slug={slug}
          patientId={patientId}
          hub={hub}
          onClose={() => setAsking(false)}
          onWaiting={(w) => {
            setWaiting((prev) => [...prev, w]);
            setAsking(false);
          }}
        />
      )}

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

/** Ask one machine — or whichever sends next — for this patient's next result. */
function RequestFromDevice({
  slug,
  patientId,
  hub,
  onClose,
  onWaiting,
}: {
  slug: string;
  patientId: string;
  hub: FilesHub;
  onClose: () => void;
  onWaiting: (w: FilesHub["waiting"][number]) => void;
}) {
  const { t } = useI18n();
  const T = t.devices;
  const { toast } = useToast();
  const [deviceId, setDeviceId] = useState<string | null>(hub.devices.length === 1 ? hub.devices[0].id : null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/c/${slug}/imaging/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patientId, kind: "file", deviceId, note }),
      });
      const body = (await res.json().catch(() => ({}))) as { request?: { id: string; created_at: string } };
      if (!res.ok || !body.request) throw new Error("failed");
      onWaiting({
        id: body.request.id,
        kind: "file",
        note: note.trim(),
        device: hub.devices.find((d) => d.id === deviceId)?.name ?? null,
        createdAt: body.request.created_at,
        teeth: [],
      });
    } catch {
      toast(t.common.genericError, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={T.requestTitle}
      footer={
        hub.devices.length ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button onClick={go} loading={busy} data-request-go>
              {T.requestGo}
            </Button>
          </div>
        ) : undefined
      }
    >
      {hub.devices.length === 0 ? (
        <div className="grid gap-3 text-sm text-ink-700" data-request-none>
          <p>{T.noMachines}</p>
          {hub.canManageDevices && (
            <Link href={`/c/${slug}/settings/devices`} className={buttonClass({ variant: "primary", size: "sm", className: "w-fit" })}>
              {T.connect}
            </Link>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-1.5" role="radiogroup" aria-label={T.request}>
            {[{ id: null as string | null, name: T.anyMachine, kind: "" }, ...hub.devices].map((d) => {
              const on = deviceId === d.id;
              return (
                <button
                  key={d.id ?? "any"}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setDeviceId(d.id)}
                  className={`flex items-center justify-between gap-3 rounded-ctl border px-3 py-2.5 text-start text-sm ${on ? "border-brand-600 bg-brand-50 font-semibold text-ink-900" : "border-line text-ink-700 hover:bg-sunken"}`}
                  data-request-option={d.id ?? "any"}
                >
                  <span>{d.name}</span>
                  {d.kind && <span className="text-[12px] font-normal text-ink-500">{(t.devices.kinds as Record<string, string>)[d.kind] ?? d.kind}</span>}
                </button>
              );
            })}
          </div>
          <Field label={T.requestNote}>
            <Input value={note} maxLength={80} placeholder={T.requestNotePlaceholder} onChange={(e) => setNote(e.target.value)} data-request-note />
          </Field>
        </div>
      )}
    </Modal>
  );
}
