"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/client";
import { formatPhone } from "@/lib/phone";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { UserPlus } from "lucide-react";

/**
 * Find a patient by name or phone, or start a new one. The appointment panel
 * and the desk's walk-in both book somebody who may or may not be on file yet.
 */
export function PatientPicker({
  slug,
  onPick,
  onCreateNew,
  autoFocus,
}: {
  slug: string;
  onPick: (p: { id: string; name: string }) => void;
  onCreateNew: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; full_name: string; phone_e164: string | null }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (val: string) => {
    setQ(val);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (val.trim().length < 2) {
        setResults([]);
        return;
      }
      const res = await fetch(`/api/c/${slug}/patients/search?q=${encodeURIComponent(val)}`);
      if (res.ok) setResults((await res.json()).results ?? []);
    }, 250);
  };

  return (
    <div className="grid gap-1.5">
      <Input value={q} onChange={(e) => search(e.target.value)} placeholder={t.calendar.searchOrCreate} autoFocus={autoFocus} />
      {results.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onPick({ id: r.id, name: r.full_name })}
          className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-start text-sm hover:bg-sunken"
        >
          <Avatar name={r.full_name} size={26} />
          <span className="flex-1 font-medium">{r.full_name}</span>
          {r.phone_e164 && (
            <span dir="ltr" className="text-[12px] text-ink-400 tnum">
              {formatPhone(r.phone_e164)}
            </span>
          )}
        </button>
      ))}
      <button
        type="button"
        onClick={onCreateNew}
        className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-start text-sm text-brand-700 hover:border-brand-400 hover:bg-brand-50/40"
      >
        <UserPlus className="h-4 w-4" />
        {t.calendar.createNew}
      </button>
    </div>
  );
}
