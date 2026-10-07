"use client";

/*
  A medical centre's other departments: every field it practises beside the
  primary specialty, as toggles. The primary is left out of the list — it is
  already chosen above — and so is "general", which is the absence of one.
*/

import { Check } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { SPECIALTIES, type Specialty } from "@/lib/specialties";

export function DepartmentPicker({
  value,
  onChange,
  primary,
  disabled,
}: {
  value: Specialty[];
  onChange: (v: Specialty[]) => void;
  primary: Specialty;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.admin.departments}>
      {SPECIALTIES.filter((s) => s !== "general" && s !== primary).map((s) => {
        const on = value.includes(s);
        return (
          <button
            key={s}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            data-department={s}
            onClick={() => onChange(on ? value.filter((x) => x !== s) : [...value, s])}
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors duration-140 disabled:opacity-50 ${
              on ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
            }`}
          >
            {on && <Check className="h-3.5 w-3.5" />}
            {t.specialties[s]}
          </button>
        );
      })}
    </div>
  );
}
