"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { IMPORT_ACCEPT } from "@/lib/import/sheet";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import {
  previewImportAction,
  commitImportAction,
  undoImportAction,
  type ImportPreview,
} from "./actions";
import type { ImportField } from "@/lib/import/parse";
import { Upload, ArrowLeft, Undo2 } from "lucide-react";

const FIELDS: ImportField[] = [
  "ignore",
  "full_name",
  "first_name",
  "last_name",
  "phone",
  "secondary_phone",
  "birth_date",
  "gender",
  "notes",
  "tags",
  "insurance_no",
];

type Batch = {
  id: string;
  filename: string;
  row_count: number;
  created_count: number;
  matched_count: number;
  skipped_count: number;
  undone_at: string | null;
  created_at: string;
  by_name: string | null;
};

export function ImportClient({
  slug,
  tz,
  batches,
}: {
  slug: string;
  tz: string;
  batches: Batch[];
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [text, setText] = useState("");
  const [filename, setFilename] = useState("");
  /** A spreadsheet is read on the server, which is a round trip worth showing. */
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pending, start] = useTransition();

  const runPreview = (mapping?: ImportField[]) =>
    start(async () => {
      const p = await previewImportAction(slug, text, mapping);
      if (p.error) {
        toast(
          p.error === "too_many"
            ? t.import.tooMany
            : p.error === "empty"
              ? t.import.nothingRead
              : t.common.required,
          "error"
        );
        return;
      }
      setPreview(p);
    });

  /*
    Reading the file in the browser rather than uploading it. The bytes never
    leave the operator's machine until they have seen what the import will do,
    and a mis-mapped file is discarded rather than sitting on our disk.
  */
  const readFile = async (file: File) => {
    setFilename(file.name);
    setReadError("");
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    /*
      An xlsx is a zip, not text, and decoding one here would show a screen of
      mojibake. Those go to the server to be read — nothing is stored, and what
      comes back is the same delimited text the paste box would have produced.
      Detected by the bytes rather than the name, because a CSV renamed .xlsx is
      a thing people try.
    */
    if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      setReading(true);
      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/c/${slug}/patients/import/read`, {
          method: "POST",
          body: form,
        });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok || !body.text) {
          setReadError(body.error === "too_big" ? t.import.fileTooBig : t.import.fileUnreadable);
          return;
        }
        setText(body.text);
        setPreview(null);
      } catch {
        setReadError(t.import.fileUnreadable);
      } finally {
        setReading(false);
      }
      return;
    }

    let decoded: string;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      decoded = new TextDecoder("utf-8").decode(bytes.subarray(3));
    } else {
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        // What Excel writes on an Arabic Windows machine.
        decoded = new TextDecoder("windows-1256").decode(bytes);
      }
    }
    setText(decoded);
    setPreview(null);
  };

  return (
    <>
      <PageHeader
        title={t.import.title}
        sub={t.import.sub}
        action={
          <Link href={`/c/${slug}/patients`}>
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
              {t.nav.patients}
            </Button>
          </Link>
        }
      />

      {!preview && (
        <Card className="mb-4">
          <CardHeader title={t.import.step1} sub={t.import.step1Sub} />
          <div className="grid gap-4 p-5">
            <div>
              <input
                type="file"
                accept={IMPORT_ACCEPT}
                disabled={reading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void readFile(f);
                }}
                className="block w-full text-sm file:me-3 file:rounded-ctl file:border-0 file:bg-brand-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-brand-700"
              />
              <p className="mt-1 text-xs text-ink-500">
                {reading ? t.import.reading : t.import.fileHint}
              </p>
              {readError && (
                <p className="mt-1 text-xs text-danger">{readError}</p>
              )}
            </div>
            {/* The path that never has an encoding problem: the clipboard
                carries text, not bytes in some codepage. */}
            <Textarea
              rows={6}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
              placeholder={t.import.pastePlaceholder}
              dir="ltr"
            />
            <div>
              <Button
                loading={pending || reading}
                disabled={!text.trim() || reading}
                onClick={() => runPreview()}
              >
                <Upload className="h-4 w-4" />
                {t.import.readIt}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {preview && (
        <>
          <Card className="mb-4">
            <CardHeader title={t.import.step2} sub={t.import.step2Sub} />
            <div className="overflow-x-auto p-5">
              <table className="w-full min-w-[36rem] text-sm">
                <tbody>
                  {preview.headers.map((h, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="py-2 pe-3 font-semibold">{h || `#${i + 1}`}</td>
                      <td className="py-2 pe-3 text-[13px] text-ink-500">
                        {preview.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(" · ")}
                      </td>
                      <td className="w-48 py-2">
                        <Select
                          value={preview.mapping[i]}
                          onChange={(e) => {
                            const next = [...preview.mapping];
                            next[i] = e.target.value as ImportField;
                            setPreview({ ...preview, mapping: next });
                          }}
                        >
                          {FIELDS.map((f) => (
                            <option key={f} value={f}>
                              {(t.import.fields as Record<string, string>)[f]}
                            </option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" loading={pending} onClick={() => runPreview(preview.mapping)}>
                  {t.import.recheck}
                </Button>
                <Button variant="outline" onClick={() => setPreview(null)}>
                  {t.common.back}
                </Button>
              </div>
            </div>
          </Card>

          <Card className="mb-4">
            <CardHeader title={t.import.step3} />
            <div className="grid gap-3 p-5">
              <div className="flex flex-wrap gap-2">
                <Badge status="brand">{preview.counts.create} {t.import.willCreate}</Badge>
                <Badge status="pending">{preview.counts.match} {t.import.willMatch}</Badge>
                {preview.counts.skip > 0 && (
                  <Badge status="neutral">{preview.counts.skip} {t.import.willSkip}</Badge>
                )}
              </div>
              {/* The skipped rows by name, because "12 skipped" is not something
                  anybody can act on. */}
              {preview.plan.some((p) => p.action === "skip") && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-line bg-sunken p-3 text-[13px]">
                  {preview.plan
                    .filter((p) => p.action === "skip")
                    .slice(0, 50)
                    .map((p) => (
                      <div key={p.line}>
                        {t.import.line} {p.line}: {p.name || "—"} —{" "}
                        {(t.import.reasons as Record<string, string>)[p.reason ?? ""] ?? p.reason}
                      </div>
                    ))}
                </div>
              )}
              <div>
                <Button
                  loading={pending}
                  disabled={preview.counts.create + preview.counts.match === 0}
                  onClick={() =>
                    start(async () => {
                      const r = await commitImportAction(slug, text, preview.mapping, filename);
                      if (r.error) {
                        toast(
                          r.error === "name_required" ? t.import.needName : t.common.required,
                          "error"
                        );
                        return;
                      }
                      toast(`${t.import.done}: ${r.created} + ${r.matched}`, "success");
                      setPreview(null);
                      setText("");
                      router.refresh();
                    })
                  }
                >
                  {t.import.commit}
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}

      {batches.length > 0 && (
        <Card>
          <CardHeader title={t.import.past} sub={t.import.pastSub} />
          <ul className="divide-y divide-line">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {b.filename || t.import.pasted}
                  </span>
                  <span className="block truncate text-[13px] text-ink-500">
                    {fmtDateTime(b.created_at, tz, locale)}
                    {b.by_name ? ` · ${b.by_name}` : ""} · {b.created_count} {t.import.willCreate},{" "}
                    {b.matched_count} {t.import.willMatch}
                  </span>
                </div>
                {b.undone_at ? (
                  <Badge status="neutral">{t.import.undone}</Badge>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await undoImportAction(slug, b.id);
                        if (r.error) return toast(t.common.required, "error");
                        toast(
                          r.kept
                            ? `${t.import.undoneN}: ${r.removed} · ${t.import.keptN}: ${r.kept}`
                            : `${t.import.undoneN}: ${r.removed}`,
                          "success"
                        );
                        router.refresh();
                      })
                    }
                  >
                    <Undo2 className="h-4 w-4" />
                    {t.import.undo}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
