"use client";

/*
  "كيف عرفت عنا؟" (0128): where the patient came from, and — for a friend, a
  doctor or "other" — who or what. Asked once, at the desk; the analytics page
  counts it.
*/

import { useI18n } from "@/lib/i18n/client";
import { Field, Input, Select } from "@/components/ui/input";
import { REFERRAL_SOURCES, REFERRAL_WITH_NOTE, asReferral } from "@/lib/referral";

export function ReferralPicker({
  source,
  note,
  onSource,
  onNote,
}: {
  source: string | null;
  note: string | null;
  onSource: (v: string | null) => void;
  onNote: (v: string) => void;
}) {
  const { t } = useI18n();
  const R = t.referral;
  const picked = asReferral(source);
  return (
    <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2 sm:gap-4" data-referral>
      <Field label={R.label}>
        <Select value={picked ?? ""} onChange={(e) => onSource(e.target.value || null)} data-referral-source>
          <option value="">{R.notAsked}</option>
          {REFERRAL_SOURCES.map((s) => (
            <option key={s} value={s}>
              {R.sources[s]}
            </option>
          ))}
        </Select>
      </Field>
      {picked && REFERRAL_WITH_NOTE.has(picked) && (
        <Field label={picked === "friend" ? R.whoFriend : picked === "doctor" ? R.whoDoctor : R.whatOther}>
          <Input defaultValue={note ?? ""} maxLength={120} onChange={(e) => onNote(e.target.value)} data-referral-note />
        </Field>
      )}
    </div>
  );
}
