import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can, hasFullControl } from "@/lib/auth";
import { monthDateRange, monthRangeUtc } from "@/lib/dates";
import {
  clinicHasCommission,
  earningsByDoctor,
  earningsDetailForDoctor,
  earningsForDoctor,
  memberHasEarnings,
  voidedButPaid,
  type DoctorEarnings,
  type EarningsLine,
} from "@/lib/earnings";
import { clinicProfit } from "@/lib/expenses";
import { EarningsClient } from "./earnings-client";

/**
 * What a doctor has earned, and what the clinic owes.
 *
 * One route serving two readers rather than two nav items. A doctor with
 * `earnings` sees their own figures and nobody else's; the clinic's own half —
 * what it kept, and what every doctor is owed — belongs to whoever holds the
 * clinic rather than to whoever was granted a capability. An admin who is also
 * a doctor holds both and sees one page with both halves, which is the case
 * this arrangement exists for.
 */
export default async function EarningsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ m?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);

  /*
    The capability is necessary and not sufficient. Every doctor holds
    `earnings`, so what decides whether this screen exists for them is whether
    the clinic actually agreed a share with *them* — checked against the
    database here, not inferred from the nav, because hiding a link is not a
    gate and this URL can be typed.
  */
  const mine = can(access, "earnings");
  /*
    The clinic's half is not grantable. `invoices.analytics` opens the takings —
    the dashboard tile, the invoice totals — and an owner hands that to a
    practice manager deliberately. What the clinic kept after every cost, and
    what each colleague is paid, is a different secret: a doctor reading the
    payout table learns what the person at the next chair earns. So the
    capability is necessary and ownership is what makes it sufficient. The AND
    matters in the other direction too — a clinic whose invoicing the agency
    de-licensed must lose this screen even for its owner.
  */
  const clinicWide = can(access, "invoices.analytics") && hasFullControl(access);
  const hasOwn =
    mine &&
    (await inClinic(access, (c) => memberHasEarnings(c, access.clinicId, access.memberId)));
  if (!hasOwn && !clinicWide) redirect(`/c/${slug}`);

  // Clamped: this is a URL, and a two-thousand-month offset is a date library
  // exception rather than an empty page.
  const offset = Math.min(0, Math.max(-60, Number(sp.m) || 0));
  const { start, end } = monthRangeUtc(access.clinic.timezone, offset);
  // The same month as calendar dates, for the expenses side — `spent_on` is a
  // `date` and comparing it against a UTC instant moves a day across the border.
  const { from: fromDate, to: toDate } = monthDateRange(access.clinic.timezone, offset);
  const scope = {
    clinicId: access.clinicId,
    from: new Date(start),
    to: new Date(end),
    includeVoided: true,
  };

  const data = await inClinic(access, async (c) => {
    /*
      `hasOwn` first, and not merely as an optimisation: a doctor whose share
      was ended still has earnings on record, and by then the clinic may have no
      live percentage with anybody. Asking only whether the *clinic* currently
      splits revenue would answer "not set up" and hide that doctor's own
      history — the thing they came to look at.
    */
    const hasCommission = hasOwn || (await clinicHasCommission(c, access.clinicId));
    /*
      No early return any more, and the reason is the person it used to shut
      out. This screen now carries what the clinic kept, not only what it owes
      its doctors — so a solo owner who splits revenue with nobody, the very
      person most interested in the profit line, was being handed an empty state
      saying revenue sharing was not set up. `hasCommission` governs the doctor
      halves and nothing else.
    */

    /*
      `access.memberId` is null while a super admin is impersonating. A naive
      `= $n` would return no rows and read as "this doctor has earned nothing",
      which is a lie about somebody's pay — so the personal half is simply not
      rendered, and support sees the team half instead.
    */
    const self: DoctorEarnings | null =
      hasOwn && access.memberId ? await earningsForDoctor(c, scope, access.memberId) : null;
    const detail: EarningsLine[] =
      hasOwn && access.memberId ? await earningsDetailForDoctor(c, scope, access.memberId) : [];

    const team = clinicWide && hasCommission ? await earningsByDoctor(c, scope) : [];
    const flagged = clinicWide && hasCommission ? await voidedButPaid(c, scope) : [];

    /*
      The profit chain. Expenses are only subtracted for somebody who may see
      them — `invoices.analytics` is the takings and `expenses` is the spending,
      and they are separate grants on purpose. A member with the takings but not
      the spending sees the chain stop at the doctors' shares rather than a
      "kept" figure that is silently missing a number.
    */
    const net = clinicWide
      ? await clinicProfit(c, {
          clinicId: access.clinicId,
          from: scope.from,
          to: scope.to,
          fromDate,
          toDate,
        })
      : null;
    const showSpend = clinicWide && can(access, "expenses");

    // Names for the payout table, and the viewer's own rate. Only the rate of
    // the person reading is selected — `members_access` would happily return
    // everybody's, and what a colleague is paid is not this screen's business.
    const ids = [...new Set([...team.map((t) => t.doctorMemberId), ...flagged.map((f) => f.doctorMemberId)])];
    const names: Record<string, string> = {};
    if (ids.length) {
      const r = await c.query(
        `select cm.id, u.full_name from clinic_members cm join users u on u.id = cm.user_id
          where cm.clinic_id = $1 and cm.id = any($2::uuid[])`,
        [access.clinicId, ids]
      );
      for (const row of r.rows) names[row.id as string] = row.full_name as string;
    }
    return { hasCommission, self, detail, team, net, flagged, names, showSpend };
  });

  const myRate = await inClinic(access, async (c) => {
    if (!hasOwn || !access.memberId) return null;
    const r = await c.query(
      `select commission_percent from clinic_members where id = $1 and clinic_id = $2`,
      [access.memberId, access.clinicId]
    );
    const v = r.rows[0]?.commission_percent;
    return v === null || v === undefined ? null : Number(v);
  });

  return (
    <EarningsClient
      slug={slug}
      currency={access.clinic.currency}
      timezone={access.clinic.timezone}
      offset={offset}
      hasCommission={data.hasCommission}
      myRate={myRate}
      self={data.self}
      detail={data.detail}
      team={data.team}
      net={data.net}
      showSpend={data.showSpend}
      flagged={data.flagged}
      names={data.names}
      showTeam={clinicWide}
    />
  );
}
