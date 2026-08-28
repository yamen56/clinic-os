"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { fmtDateTime } from "@/lib/dates";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { VoiceNote } from "@/components/voice-note";
import { StickyNote } from "lucide-react";

type Row = {
  id: string;
  body: string;
  created_at: string;
  author: string | null;
  edited_at: string | null;
  audio_path: string | null;
  audio_seconds: number | null;
};

/**
 * Notes about this visit, inside the appointment panel.
 *
 * The same records as the patient file's notes tab, filtered to one
 * appointment — written here because this is where somebody is standing when
 * they have something to write. Sending them to the patient file, the notes
 * tab and a visit picker is three steps between a thought and a record, and the
 * note that takes three steps is the note that does not get written.
 *
 * Read-only afterwards on purpose. Correcting a note means its version history,
 * its category and its recording, and all of that lives on the patient file;
 * duplicating the editor here would be a second place to get it wrong. The link
 * at the foot goes there.
 */
export function AppointmentNotes({
  slug,
  appointmentId,
  patientId,
  patientName,
  startsAt,
  serviceName,
  tz,
}: {
  slug: string;
  appointmentId: string;
  patientId: string;
  /** Named on the heading: this panel is reached from a calendar grid, where
   *  the surrounding context is the day rather than the person. */
  patientName: string;
  startsAt: string;
  serviceName: string | null;
  tz: string;
}) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/c/${slug}/appointments/${appointmentId}/notes`);
      if (!res.ok) return setRows([]);
      const d = await res.json();
      setRows(d.notes ?? []);
    } catch {
      setRows([]);
    }
  }, [slug, appointmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/c/${slug}/appointments/${appointmentId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) return toast(t.common.genericError, "error");
      setDraft("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <span className="mb-0.5 flex items-center gap-1.5 text-[13px] font-medium text-ink-700">
        <StickyNote className="h-3.5 w-3.5 text-ink-400" />
        {t.patients.notes.visitNotes}
        {rows?.length ? <span className="text-ink-400 tnum">{rows.length}</span> : null}
      </span>
      {/* Whose visit, and which one. Written out because a note filed from here
          is a clinical record about a named person, and the panel above is a
          form that can still be edited — the heading should not be the only
          thing standing between a note and the wrong patient. */}
      <p className="mb-1.5 text-[12px] text-ink-500">
        {patientName} · {fmtDateTime(startsAt, tz, locale)}
        {serviceName ? ` · ${serviceName}` : ""}
      </p>

      {rows === null ? (
        <div className="h-8 rounded-lg bg-sunken" />
      ) : rows.length === 0 ? (
        <p className="mb-2 text-[12px] text-ink-400">{t.patients.notes.noVisitNotes}</p>
      ) : (
        <ul className="mb-2 grid gap-2">
          {rows.map((n) => (
            <li key={n.id} className="rounded-lg border border-line bg-sunken/40 p-2.5">
              <div className="mb-0.5 text-[11px] text-ink-400">
                {n.author ? `${n.author} · ` : ""}
                {fmtDateTime(n.created_at, tz, locale)}
                {n.edited_at ? ` · ${t.patients.notes.edited}` : ""}
              </div>
              {n.audio_path && (
                <VoiceNote
                  src={`/api/c/${slug}/notes/${n.id}/audio`}
                  seconds={n.audio_seconds}
                  label={t.patients.notes.playVoice}
                />
              )}
              {n.body && (
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-900">
                  {n.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t.patients.notes.addVisitNote}
        className="min-h-16"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <Link
          href={`/c/${slug}/patients/${patientId}`}
          className="text-[12px] text-ink-500 hover:text-brand-700"
        >
          {t.patients.notes.openPatientFile}
        </Link>
        <Button size="sm" onClick={add} loading={busy} disabled={!draft.trim() || busy}>
          {t.patients.notes.add}
        </Button>
      </div>
    </div>
  );
}
