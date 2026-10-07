import Link from "next/link";
import type { Dict } from "@/lib/i18n/en";
import type { SupportVisit } from "@/lib/support-visits";
import { fmtDateTime, fmtTime } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";

/**
 * The record of agency visits, as both sides read it.
 *
 * One component for the agency panel and the clinic's own settings, so the
 * clinic is never shown a softer account than the agency keeps. What differs is
 * only what each audience needs to be told: the agency sees which clinic and
 * from where; the clinic sees which of its patients, and can open them.
 */
export function SupportVisitList({
  visits,
  t,
  locale,
  showClinic = false,
  showOrigin = false,
  patientHref,
}: {
  visits: SupportVisit[];
  t: Dict;
  locale: string;
  /** For a list that spans clinics — the agency's team-wide view. */
  showClinic?: boolean;
  /** The admin's address and IP: for the agency, not for the clinic. */
  showOrigin?: boolean;
  /**
   * Names and links each opened patient file. The clinic's side only: the
   * agency panel is open to admins who cannot enter a clinic at all, and a list
   * of whose records were read is itself patient data.
   */
  patientHref?: (patientId: string) => string;
}) {
  const v = t.supportVisits;

  const duration = (visit: SupportVisit) => {
    const end = new Date(visit.endedAt ?? visit.lastSeenAt).getTime();
    const mins = Math.max(0, Math.round((end - new Date(visit.startedAt).getTime()) / 60000));
    if (mins < 1) return v.underMinute;
    if (mins < 60) return v.minutes.replace("{n}", String(mins));
    return v.hoursMinutes
      .replace("{h}", String(Math.floor(mins / 60)))
      .replace("{m}", String(mins % 60));
  };

  return (
    <ul className="divide-y divide-line">
      {visits.map((visit) => {
        const shown = patientHref ? visit.patients.slice(0, 8) : [];
        const more = shown.length ? visit.patientsViewed - shown.length : 0;
        const activity: { text: string; tone?: "danger" }[] = [];
        if (visit.patientsViewed > 0)
          activity.push({
            text:
              visit.patientsViewed === 1
                ? v.patientsOne
                : v.patientsMany.replace("{n}", String(visit.patientsViewed)),
          });
        if (visit.exports > 0)
          activity.push({
            text: visit.exports === 1 ? v.exportsOne : v.exportsMany.replace("{n}", String(visit.exports)),
            tone: "danger",
          });
        if (visit.changes > 0)
          activity.push({
            text: visit.changes === 1 ? v.changesOne : v.changesMany.replace("{n}", String(visit.changes)),
          });

        return (
          <li key={visit.id} className="grid gap-1.5 px-5 py-3.5" data-visit={visit.id}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold text-ink-900">
                <bdi>{visit.adminName}</bdi>
              </span>
              {showOrigin && (
                <span className="text-[13px] text-ink-500" dir="ltr">
                  {visit.adminEmail}
                </span>
              )}
              {showClinic && (
                <Link
                  href={`/admin/clinics/${visit.clinicSlug}`}
                  className="text-[13px] font-medium text-brand-700 hover:underline"
                >
                  {(locale === "ar" && visit.clinicNameAr) || visit.clinicName}
                </Link>
              )}
              <span className="ms-auto">
                {visit.endedAt ? (
                  <Badge status="neutral">{v.ended[visit.endReason ?? "signed_out"]}</Badge>
                ) : (
                  <Badge status="pending" dot>
                    {v.open}
                  </Badge>
                )}
              </span>
            </div>

            {/* Isolated, not quoted: a reason is often in the other language from
                the page, and curly quotes land on the wrong side of it in RTL. */}
            <p className="text-sm text-ink-700">
              <bdi>{visit.reason}</bdi>
            </p>

            <p className="text-[13px] text-ink-500">
              <span className="tnum">{fmtDateTime(visit.startedAt, visit.timezone, locale)}</span>
              {" · "}
              <span className="tnum">{duration(visit)}</span>
              {!visit.endedAt && (
                <>
                  {" · "}
                  {v.lastActive.replace("{t}", fmtTime(visit.lastSeenAt, visit.timezone, locale))}
                </>
              )}
              {showOrigin && visit.ip && (
                <>
                  {" · "}
                  <span dir="ltr">{v.from.replace("{ip}", visit.ip)}</span>
                </>
              )}
            </p>

            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
              {activity.length === 0 ? (
                <span className="text-ink-500">{v.nothing}</span>
              ) : (
                activity.map((a, i) => (
                  <span key={i} className={a.tone === "danger" ? "font-medium text-danger" : "text-ink-700"}>
                    {i > 0 && <span className="text-ink-300">· </span>}
                    {a.text}
                  </span>
                ))
              )}
            </p>

            {shown.length > 0 && (
              <p className="flex flex-wrap gap-1.5">
                {shown.map((p) =>
                  patientHref ? (
                    <Link
                      key={p.id}
                      href={patientHref(p.id)}
                      className="rounded-full bg-ink-900/4 px-2 py-0.5 text-xs text-ink-700 hover:bg-ink-900/8"
                    >
                      {p.name}
                    </Link>
                  ) : (
                    <span key={p.id} className="rounded-full bg-ink-900/4 px-2 py-0.5 text-xs text-ink-700">
                      {p.name}
                    </span>
                  )
                )}
                {more > 0 && (
                  <span className="px-1 py-0.5 text-xs text-ink-500">
                    {v.morePatients.replace("{n}", String(more))}
                  </span>
                )}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
