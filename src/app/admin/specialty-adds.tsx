"use client";

import { useI18n } from "@/lib/i18n/client";
import { profileFor } from "@/lib/specialty-profile";

/**
 * What the chosen specialties bring, said where they are chosen: the modules
 * they switch on, the machines put first when the clinic connects one, the
 * kinds of result its patients' Files are sorted by. So picking "Cardiology"
 * is visibly more than a label.
 */
export function SpecialtyAdds({ specialties }: { specialties: string[] }) {
  const { t } = useI18n();
  const p = profileFor(specialties);
  const chip = "inline-flex rounded-full bg-brand-50 px-2.5 py-0.5 text-[12.5px] font-medium text-ink-900";
  return (
    <div className="grid gap-2 rounded-ctl border border-line bg-canvas px-3.5 py-3 text-[13px]" data-specialty-adds>
      <div className="font-semibold text-ink-900">{t.admin.specialtyAdds}</div>
      {p.modules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-adds-modules>
          <span className="text-ink-500">{t.admin.addsModules}</span>
          {p.modules.map((m) => (
            <span key={m} className={`${chip} bg-st-confirmed-soft`}>
              {t.caps[m]}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5" data-adds-devices>
        <span className="text-ink-500">{t.admin.addsDevices}</span>
        {p.devices.map((d) => (
          <span key={d} className={chip}>
            {t.devices.kinds[d]}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" data-adds-files>
        <span className="text-ink-500">{t.admin.addsFiles}</span>
        {p.files.map((k) => (
          <span key={k} className={chip}>
            {t.patients.files.kinds[k]}
          </span>
        ))}
      </div>
    </div>
  );
}
