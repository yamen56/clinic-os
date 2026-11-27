import Link from "next/link";
import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { dictForClinic, getLocale } from "@/lib/i18n";
import { PageHeader, Card } from "@/components/ui/card";
import { fmtMoney } from "@/lib/dates";
import { branchFigures } from "@/lib/branches-report";

/**
 * The clinic's branches side by side (2026-11-27): one row per branch the
 * person may read the takings of, and a total — the owner's question "how are
 * my clinics doing today and this month", answered without opening each one.
 *
 * Only branches in this clinic's group, and only those where the person holds
 * `invoices.analytics` there (lib/branches-report).
 */
export default async function BranchesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await guardClinic(slug);
  const groupId = access.clinic.groupId;
  if (!groupId) redirect(`/c/${slug}`);
  const branches = access.session.memberships.filter(
    (m) => m.groupId === groupId && !m.deletedAt && m.caps["invoices.analytics"]
  );
  if (branches.length < 2) redirect(`/c/${slug}`);
  const [t, locale] = await Promise.all([dictForClinic(access.clinic.vocabulary), getLocale()]);
  const rows = await branchFigures(access.session.user.id, branches, locale);
  // One currency is the ordinary case; a group across countries gets no misleading sum.
  const oneCurrency = new Set(rows.map((r) => r.currency)).size === 1;
  const sum = (k: "today" | "collected" | "owed" | "newPatients" | "noShows") => rows.reduce((a, r) => a + r[k], 0);
  const money = (n: number, cur: string) => fmtMoney(n, cur, locale);
  const cols = [t.branches.today, t.branches.collected, t.branches.owed, t.branches.newPatients, t.branches.noShows];

  return (
    <>
      <PageHeader title={t.branches.title} sub={t.branches.sub} />
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm" data-branches-report>
          <thead>
            <tr className="border-b border-line text-[0.75rem] text-ink-500">
              <th className="px-4 py-3 text-start font-medium">{t.branches.branch}</th>
              {cols.map((c) => (
                <th key={c} className="px-4 py-3 text-end font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.slug} data-branch-row={r.slug}>
                <td className="px-4 py-3">
                  <Link href={`/c/${r.slug}`} className="font-medium text-ink-900 hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-end tnum">{r.today}</td>
                <td className="px-4 py-3 text-end tnum">{money(r.collected, r.currency)}</td>
                <td className="px-4 py-3 text-end tnum">{money(r.owed, r.currency)}</td>
                <td className="px-4 py-3 text-end tnum">{r.newPatients}</td>
                <td className="px-4 py-3 text-end tnum">{r.noShows}</td>
              </tr>
            ))}
          </tbody>
          {oneCurrency && (
            <tfoot>
              <tr className="border-t border-line font-semibold" data-branches-total>
                <td className="px-4 py-3">{t.branches.total}</td>
                <td className="px-4 py-3 text-end tnum">{sum("today")}</td>
                <td className="px-4 py-3 text-end tnum">{money(sum("collected"), rows[0].currency)}</td>
                <td className="px-4 py-3 text-end tnum">{money(sum("owed"), rows[0].currency)}</td>
                <td className="px-4 py-3 text-end tnum">{sum("newPatients")}</td>
                <td className="px-4 py-3 text-end tnum">{sum("noShows")}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </Card>
    </>
  );
}
