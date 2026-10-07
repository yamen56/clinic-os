"use client";

/*
  A photo straight from a camera into the patient's file: an intraoral camera
  on its USB lead (which the computer sees as a webcam), the tablet's own
  camera, or a phone's. No install and no export folder — the browser asks
  once for the camera, the doctor frames the tooth, taps Capture, and the
  photo is saved as the patient's.

  Every camera the device has is offered, and the last one chosen is
  remembered on this device, because an intraoral camera is rarely the default.
*/

import { useEffect, useRef, useState } from "react";
import { Camera, RotateCcw } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

const KEY = "clinicti.camera";

export function CameraCapture({ open, onClose, onPhoto }: { open: boolean; onClose: () => void; onPhoto: (f: File) => void }) {
  const { t } = useI18n();
  const T = t.dental;
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState<string>("");
  const [error, setError] = useState<"none" | "denied" | null>(null);
  const [shot, setShot] = useState<{ url: string; blob: Blob } | null>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
  };

  // Start (or switch) the camera while the dialog is open and nothing is captured.
  useEffect(() => {
    if (!open || shot) return;
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("none");
        return;
      }
      try {
        let saved = "";
        try {
          saved = localStorage.getItem(KEY) ?? "";
        } catch {}
        const want = device || saved;
        const s = await navigator.mediaDevices.getUserMedia({
          video: want ? { deviceId: { exact: want }, width: { ideal: 1920 } } : { facingMode: "environment", width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stop();
        stream.current = s;
        if (video.current) video.current.srcObject = s;
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        setDevices(all);
        const active = s.getVideoTracks()[0]?.getSettings().deviceId ?? "";
        if (active && active !== device) setDevice(active);
        setError(null);
      } catch (e) {
        const name = (e as DOMException)?.name;
        // A remembered camera that is unplugged: fall back to whatever there is.
        if (name === "OverconstrainedError" || name === "NotFoundError") {
          try {
            localStorage.removeItem(KEY);
          } catch {}
          if (device) setDevice("");
          else setError("none");
          return;
        }
        setError(name === "NotAllowedError" ? "denied" : "none");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, device, shot]);

  useEffect(() => {
    if (!open) {
      stop();
      setShot(null);
      setError(null);
    }
  }, [open]);
  useEffect(() => () => stop(), []);

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return;
      stop();
      setShot({ url: URL.createObjectURL(blob), blob });
    }, "image/jpeg", 0.92);
  };

  const save = () => {
    if (!shot) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    onPhoto(new File([shot.blob], `photo-${stamp}.jpg`, { type: "image/jpeg" }));
    URL.revokeObjectURL(shot.url);
    setShot(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={T.cameraTitle} wide>
      <div className="grid gap-3" data-camera>
        {devices.length > 1 && !shot && (
          <label className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-ink-500">{T.cameraPick}</span>
            <select
              value={device}
              onChange={(e) => {
                setDevice(e.target.value);
                try {
                  localStorage.setItem(KEY, e.target.value);
                } catch {}
              }}
              className="select-chevron h-9 min-w-0 flex-1 appearance-none rounded-ctl border border-line bg-surface ps-3 pe-8 text-base md:text-sm"
            >
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `${T.camera} ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="relative aspect-video overflow-hidden rounded-card bg-ink-900">
          {error ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-[14px] text-white/80">{error === "denied" ? T.cameraDenied : T.cameraNone}</div>
          ) : shot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shot.url} alt="" className="h-full w-full object-contain" />
          ) : (
            <video ref={video} autoPlay playsInline muted className="h-full w-full object-contain" />
          )}
        </div>
        <div className="flex justify-end gap-2">
          {shot ? (
            <>
              <Button variant="outline" onClick={() => setShot(null)}>
                <RotateCcw className="h-4 w-4" />
                {T.retake}
              </Button>
              <Button onClick={save}>{T.usePhoto}</Button>
            </>
          ) : (
            <Button onClick={capture} disabled={!!error}>
              <Camera className="h-4 w-4" />
              {T.capture}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
