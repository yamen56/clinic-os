"use client";

/*
  The rest of a patient's family (0127), where the desk talks to them: the
  inbox's patient panel. The mother writes in about her son; his file and a
  booking for him are one tap away, without searching.
*/

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarPlus, Users } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { familyRoleLabel, type FamilyRole } from "@/lib/families";
import { Avatar } from "@/components/ui/misc";

type Kin = { id: string; name: string; role: FamilyRole | null; gender: string | null };

export function FamilyList({ slug, patientId, canBook }: { slug: string; patientId: string; canBook: boolean }) {
  const { t } = useI18n();
  const [kin, setKin] = useState<Kin[]>([]);
  useEffect(() => {
    let live = true;
    void fetch(`/api/c/${slug}/patients/${patientId}/family`)
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((j) => live && setKin(j.members ?? []))
      .catch(() => live && setKin([]));
    return () => {
      live = false;
    };
  }, [slug, patientId]);
  if (!kin.length) return null;
  return (
    <div className="grid gap-1.5" data-inbox-family={kin.length}>
      <span className="flex items-center gap-1.5 text-[0.75rem] font-semibold text-ink-500">
        <Users className="h-3.5 w-3.5" />
        {t.family.title}
      </span>
      <ul className="grid gap-1">
        {kin.map((k) => {
          const role = familyRoleLabel(k.role, k.gender, t.family);
          return (
            <li key={k.id} className="flex items-center gap-2 rounded-lg bg-sunken px-2.5 py-1.5" data-inbox-family-member={k.id}>
              <Avatar name={k.name} size={24} />
              <Link href={`/c/${slug}/patients/${k.id}`} className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-ink-900 hover:text-brand-700 hover:underline">
                {k.name}
                {role && <span className="font-normal text-ink-500"> · {role}</span>}
              </Link>
              {canBook && (
                <Link
                  href={`/c/${slug}/calendar?patient=${k.id}`}
                  aria-label={`${t.family.book} · ${k.name}`}
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-brand-700 hover:bg-surface"
                >
                  <CalendarPlus className="h-4 w-4" />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
