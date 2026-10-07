"use client";

/*
  The patient's x-rays and photos, in the chart rather than two tabs away.

  A row of thumbnails, newest first, each saying what it is, when, and which
  teeth it is pinned to; tapping one opens the viewer. The add buttons upload
  into the patient's own Files — the same store the Files tab reads — and on a
  phone they offer the camera, which is how a photo of a film x-ray or an
  intraoral shot gets in.
*/

import { useRef } from "react";
import { Camera, FileText, Radiation, ScanLine, Video } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateOnly } from "@/lib/dates";
import { isPicture, type ChartImage } from "./image-viewer";

export function ImageThumb({ img, pinned, onOpen, size = "md" }: { img: ChartImage; pinned: string[]; onOpen: () => void; size?: "sm" | "md" }) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const box = size === "sm" ? "h-16 w-20" : "h-[4.5rem] w-24";
  return (
    <button type="button" onClick={onOpen} className="group/thumb w-fit shrink-0 snap-start text-start" data-image={img.id}>
      <span className={`relative block overflow-hidden rounded-ctl border border-line bg-ink-900 ${box}`}>
        {isPicture(img) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img.src} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-220 group-hover/thumb:scale-105" />
        ) : (
          <span className="grid h-full w-full place-items-center bg-sunken text-ink-500">
            <FileText className="h-6 w-6" />
          </span>
        )}
        <span className="absolute start-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">{T.imageKinds[img.kind]}</span>
        {pinned.length > 0 && (
          <span className="absolute bottom-1 end-1 rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-bold text-ink-900 tabular-nums">
            {pinned.length > 3 ? `${pinned.slice(0, 3).join(" ")}…` : pinned.join(" ")}
          </span>
        )}
      </span>
      {size === "md" && <span className="mt-1 block text-[11.5px] text-ink-500 tabular-nums">{fmtDateOnly(img.date, locale)}</span>}
    </button>
  );
}

export function AddImageButtons({
  onFile,
  busy,
  compact,
  onTakeXray,
  onCamera,
}: {
  onFile: (kind: "xray" | "photo", f: File) => void;
  busy: boolean;
  compact?: boolean;
  /** Arm the imaging station: the next image the x-ray machine saves comes here. */
  onTakeXray?: () => void;
  /** Capture from a camera on this device — an intraoral camera, a tablet's own. */
  onCamera?: () => void;
}) {
  const { t } = useI18n();
  const T = t.dental;
  const xray = useRef<HTMLInputElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const tile = `flex shrink-0 snap-start flex-col items-center justify-center gap-1 rounded-ctl border border-dashed border-line-strong bg-surface text-[11.5px] font-semibold text-ink-700 transition-colors hover:bg-sunken disabled:opacity-50 ${
    compact ? "h-16 w-20" : "h-[4.5rem] w-24"
  }`;
  return (
    <>
      {onTakeXray && (
        <button
          type="button"
          className={`${tile} border-solid border-brand-300 bg-brand-50 text-brand-700 hover:bg-brand-100`}
          onClick={onTakeXray}
          disabled={busy}
          data-take-xray
        >
          <Radiation className="h-5 w-5" />
          {T.takeXray}
        </button>
      )}
      {onCamera && (
        <button type="button" className={tile} onClick={onCamera} disabled={busy} data-add-image="camera">
          <Video className="h-5 w-5 text-ink-500" />
          {T.camera}
        </button>
      )}
      <button type="button" className={tile} onClick={() => xray.current?.click()} disabled={busy} data-add-image="xray">
        <ScanLine className="h-5 w-5 text-ink-500" />
        {T.addXray}
      </button>
      <button type="button" className={tile} onClick={() => photo.current?.click()} disabled={busy} data-add-image="photo">
        <Camera className="h-5 w-5 text-ink-500" />
        {T.addPhoto}
      </button>
      <input
        ref={xray}
        type="file"
        accept="image/*,application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile("xray", f);
        }}
      />
      <input
        ref={photo}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile("photo", f);
        }}
      />
    </>
  );
}

export function ImageStrip({
  images,
  pins,
  busy,
  canAdd,
  onOpen,
  onFile,
  onTakeXray,
  onCamera,
}: {
  images: ChartImage[];
  pins: Record<string, string[]>;
  busy: boolean;
  canAdd: boolean;
  onOpen: (index: number) => void;
  onFile: (kind: "xray" | "photo", f: File) => void;
  onTakeXray?: () => void;
  onCamera?: () => void;
}) {
  const { t } = useI18n();
  const T = t.dental;
  return (
    <section className="mt-4" aria-label={T.images}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h4 className="text-[13px] font-semibold text-ink-900">
          {T.images}
          {images.length > 0 && <span className="ms-2 rounded-full bg-sunken px-2 py-0.5 text-[12px] text-ink-500 tabular-nums">{images.length}</span>}
        </h4>
        <span className="text-[11.5px] text-ink-500">{busy ? T.uploading : canAdd ? T.savedToFiles : ""}</span>
      </div>
      <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1" data-image-strip>
        {canAdd && <AddImageButtons onFile={onFile} busy={busy} onTakeXray={onTakeXray} onCamera={onCamera} />}
        {images.map((img, i) => (
          <ImageThumb key={img.id} img={img} pinned={pins[img.id] ?? []} onOpen={() => onOpen(i)} />
        ))}
        {images.length === 0 && !canAdd && <p className="py-4 text-[13px] text-ink-500">{T.noImages}</p>}
      </div>
    </section>
  );
}
