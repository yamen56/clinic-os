"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { Upload, Trash2, ChevronLeft, ChevronRight, PenTool } from "lucide-react";

/**
 * Field placement on an uploaded PDF.
 *
 * The file itself is never re-typeset — it is the clinic's own agreement and has
 * to come out the other side byte-identical apart from what was stamped on it.
 * So this editor only records *where* things go, as fractions of the page rather
 * than pixels: the same box lands correctly whether it was placed on a phone at
 * 340px wide or printed at A4, and it survives a different zoom next week.
 *
 * pdf.js renders the pages here, in the browser, purely for the operator to aim
 * at. Nothing it produces reaches the finished document.
 */

export type PlacedField = {
  id?: string;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  field_type: "signature" | "initials" | "date" | "text" | "checkbox";
  assigned_role_key: string;
  is_required: boolean;
  label: string;
  prefilled_value: string | null;
  sort: number;
};

type Role = { key: string; label: string; label_ar: string | null };

/** Sensible starting sizes, as page fractions. A signature box is wide and short. */
const DEFAULT_SIZE: Record<PlacedField["field_type"], { w: number; h: number }> = {
  signature: { w: 0.28, h: 0.055 },
  initials: { w: 0.09, h: 0.045 },
  date: { w: 0.18, h: 0.03 },
  text: { w: 0.24, h: 0.03 },
  checkbox: { w: 0.03, h: 0.025 },
};

export function PdfFieldPlacer({
  slug,
  templateId,
  pdfPath,
  onPdfPathChange,
  roles,
  fields,
  onFieldsChange,
}: {
  slug: string;
  templateId: string | null;
  pdfPath: string | null;
  onPdfPathChange: (path: string | null) => void;
  roles: Role[];
  fields: PlacedField[];
  onFieldsChange: (f: PlacedField[]) => void;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [uploading, setUploading] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [tool, setTool] = useState<PlacedField["field_type"]>("signature");
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [rendering, setRendering] = useState(false);

  const roleLabel = (key: string) => {
    const r = roles.find((x) => x.key === key);
    return r ? (locale === "ar" ? r.label_ar || r.label : r.label) : key;
  };

  /* ------------------------------------------------------------- rendering */

  const renderPage = useCallback(
    async (pageNumber: number) => {
      if (!pdfPath || !canvasRef.current) return;
      setRendering(true);
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        const url = `/api/c/${slug}/documents/template-pdf?path=${encodeURIComponent(pdfPath)}`;
        const doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
        setPageCount(doc.numPages);
        const p = await doc.getPage(Math.min(pageNumber, doc.numPages));

        const canvas = canvasRef.current;
        const wrapWidth = pageRef.current?.clientWidth ?? 700;
        const base = p.getViewport({ scale: 1 });
        const scale = wrapWidth / base.width;
        const viewport = p.getViewport({ scale });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        const ctx = canvas.getContext("2d")!;
        await p.render({ canvas, canvasContext: ctx, viewport }).promise;
      } catch (e) {
        console.error("pdf render failed", e);
        toast(t.docTemplates.errors.badPdf, "error");
      } finally {
        setRendering(false);
      }
    },
    [pdfPath, slug, t.docTemplates.errors.badPdf, toast]
  );

  useEffect(() => {
    void renderPage(page);
  }, [page, renderPage]);

  /* --------------------------------------------------------------- uploads */

  const upload = async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      toast(t.docTemplates.errors.tooLarge, "error");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      if (templateId) fd.set("templateId", templateId);
      const res = await fetch(`/api/c/${slug}/documents/upload-template`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        toast(t.docTemplates.errors.badPdf, "error");
        return;
      }
      const data = (await res.json()) as { path: string; pages: number };
      onPdfPathChange(data.path);
      setPageCount(data.pages);
      setPage(1);
    } finally {
      setUploading(false);
    }
  };

  /* ----------------------------------------------------------- box drawing */

  const rel = (e: React.PointerEvent) => {
    const rect = pageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!pdfPath) return;
    // Clicking an existing box selects it rather than starting a new one.
    if ((e.target as HTMLElement).closest("[data-field-box]")) return;
    e.preventDefault();
    const p = rel(e);
    setSelected(null);
    setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = rel(e);
    setDrag({
      x: Math.min(drag.x, p.x),
      y: Math.min(drag.y, p.y),
      w: Math.abs(p.x - drag.x),
      h: Math.abs(p.y - drag.y),
    });
  };

  const onUp = () => {
    if (!drag) return;
    const size = DEFAULT_SIZE[tool];
    // A tap places a default-sized box; a drag uses what was drawn. Below the
    // threshold a "drag" is really a tap that moved a couple of pixels.
    const box =
      drag.w < 0.02 || drag.h < 0.012
        ? { x: drag.x, y: drag.y, w: size.w, h: size.h }
        : drag;

    const next: PlacedField = {
      page_number: page,
      x: Math.min(box.x, 1 - box.w),
      y: Math.min(box.y, 1 - box.h),
      width: box.w,
      height: box.h,
      field_type: tool,
      assigned_role_key: roles[0]?.key ?? "patient",
      is_required: true,
      label: "",
      prefilled_value: null,
      sort: fields.filter((f) => f.page_number === page).length,
    };
    onFieldsChange([...fields, next]);
    setSelected(fields.length);
    setDrag(null);
  };

  const pageFields = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.page_number === page);

  const update = (index: number, patch: Partial<PlacedField>) =>
    onFieldsChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-[15px] font-semibold">{t.docTemplates.uploadTitle}</h2>
          <p className="mt-0.5 text-[13px] text-ink-500">{t.docTemplates.uploadSub}</p>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        <Button variant="outline" loading={uploading} onClick={() => fileInput.current?.click()}>
          <Upload className="h-4 w-4" />
          {pdfPath ? t.docTemplates.uploadReplace : t.docTemplates.uploadPick}
        </Button>
      </div>

      {!pdfPath ? (
        <div className="p-8 text-center text-sm text-ink-500">{t.docTemplates.uploadSub}</div>
      ) : (
        <div className="grid gap-4 p-5 lg:grid-cols-[1fr_17rem]">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-semibold text-ink-500">
                {t.docTemplates.placeFields}
              </span>
              <div className="flex gap-1 rounded-full bg-sunken p-0.5">
                {(["signature", "initials", "date", "text", "checkbox"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTool(k)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      tool === k ? "bg-surface text-brand-700 shadow-card" : "text-ink-500"
                    }`}
                  >
                    {(t.docTemplates.fieldTypes as Record<string, string>)[k]}
                  </button>
                ))}
              </div>
              <span className="text-[12px] text-ink-400">{t.docTemplates.placeHint}</span>
            </div>

            <div
              ref={pageRef}
              dir="ltr"
              className="relative w-full select-none overflow-hidden rounded-card border border-line bg-white"
              style={{ touchAction: "none" }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
            >
              <canvas ref={canvasRef} className="block w-full" />
              {rendering && <span className="slim-progress absolute inset-x-0 top-0" />}

              {pageFields.map(({ f, i }) => (
                <div
                  key={i}
                  data-field-box
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelected(i);
                  }}
                  className={`absolute cursor-move rounded border-2 text-[10px] font-semibold ${
                    selected === i
                      ? "border-brand-600 bg-brand-500/25"
                      : "border-brand-400/70 bg-brand-400/15"
                  }`}
                  style={{
                    left: `${f.x * 100}%`,
                    top: `${f.y * 100}%`,
                    width: `${f.width * 100}%`,
                    height: `${f.height * 100}%`,
                  }}
                  title={roleLabel(f.assigned_role_key)}
                >
                  <span className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden whitespace-nowrap px-0.5 text-brand-900">
                    {(t.docTemplates.fieldTypes as Record<string, string>)[f.field_type]}
                  </span>
                </div>
              ))}

              {drag && (
                <div
                  className="pointer-events-none absolute rounded border-2 border-dashed border-brand-600 bg-brand-500/20"
                  style={{
                    left: `${drag.x * 100}%`,
                    top: `${drag.y * 100}%`,
                    width: `${drag.w * 100}%`,
                    height: `${drag.h * 100}%`,
                  }}
                />
              )}
            </div>

            {pageCount > 1 && (
              <div className="mt-3 flex items-center justify-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page <= 1}
                  aria-label={t.common.back}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
                </Button>
                <span className="text-[13px] tnum">
                  {t.docTemplates.pageOf
                    .replace("{n}", String(page))
                    .replace("{total}", String(pageCount))}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page >= pageCount}
                  aria-label={t.common.next}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                >
                  <ChevronRight className="h-4 w-4 rtl:rotate-180" />
                </Button>
              </div>
            )}
          </div>

          <div className="grid content-start gap-3">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              <PenTool className="h-4 w-4 text-ink-400" />
              {t.docTemplates.placeFields}
            </h3>
            {pageFields.length === 0 ? (
              <p className="text-[12px] text-ink-500">{t.docTemplates.placeEmpty}</p>
            ) : (
              <ul className="grid gap-1">
                {pageFields.map(({ f, i }) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => setSelected(i)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-start text-[12px] transition-colors ${
                        selected === i ? "border-brand-500 bg-brand-50" : "border-line hover:bg-sunken"
                      }`}
                    >
                      <span className="flex-1 font-medium">
                        {(t.docTemplates.fieldTypes as Record<string, string>)[f.field_type]}
                      </span>
                      <span className="text-ink-400">{roleLabel(f.assigned_role_key)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selected !== null && fields[selected] && (
              <div className="grid gap-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
                <Field label={t.docTemplates.assignTo}>
                  <Select
                    value={fields[selected].assigned_role_key}
                    onChange={(e) => update(selected, { assigned_role_key: e.target.value })}
                  >
                    {roles.map((r) => (
                      <option key={r.key} value={r.key}>
                        {roleLabel(r.key)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t.docTemplates.fieldLabel}>
                  <Input
                    value={fields[selected].label}
                    onChange={(e) => update(selected, { label: e.target.value })}
                  />
                </Field>
                {(fields[selected].field_type === "text" ||
                  fields[selected].field_type === "date") && (
                  <Field label={t.docTemplates.prefilled}>
                    <Input
                      value={fields[selected].prefilled_value ?? ""}
                      onChange={(e) => update(selected, { prefilled_value: e.target.value || null })}
                    />
                  </Field>
                )}
                <label className="flex items-center justify-between gap-2 text-[12px]">
                  <span>{t.docs.requiredSigner}</span>
                  <Toggle
                    checked={fields[selected].is_required}
                    label={t.docs.requiredSigner}
                    onChange={(v) => update(selected, { is_required: v })}
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onFieldsChange(fields.filter((_, i) => i !== selected));
                    setSelected(null);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                  {t.docTemplates.deleteField}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
