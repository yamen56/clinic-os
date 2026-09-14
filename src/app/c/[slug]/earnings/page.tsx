import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { monthRangeUtc } from "@/lib/dates";
import {
  clinicHasCommission,
  clinicNetRevenue,
  earningsByDoctor,
  earningsDetailForDoctor,
  earningsForDoctor,
  memberHasEarnings,
  voidedButPaid,
  type DoctorEarnings,
  type EarningsLine,
} from "@/lib/earnings";
import { EarningsClient } from "./earnings-client";

/**
 * What a doctor has earned, and what the clinic owes.
 *
 * One route serving two readers rather than two nav items. A doctor with
 * `earnings` sees their own figures and nobody else's; somebody with
 * `invoices.analytics` also gets the payout table for every doctor. Most owners
 * hold both and see one page with both halves.
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
  const all = can(access, "invoices.analytics");
  const hasOwn =
    mine &&
    (await inClinic(access, (c) => memberHasEarnings(c, access.clinicId, access.memberId)));
  if (!hasOwn && !all) redirect(`/c/${slug}`);

  // Clamped: this is a URL, and a two-thousand-month offset is a date library
  // exception rather than an empty page.
  const offset = Math.min(0, Math.max(-60, Number(sp.m) || 0));
  const { start, end } = monthRangeUtc(access.clinic.timezone, offset);
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
    if (!hasCommission) return { hasCommission, self: null, detail: [], team: [], net: null, flagged: [], names: {} };

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

    const team = all ? await earningsByDoctor(c, scope) : [];
    const net = all
      ? await clinicNetRevenue(c, { clinicId: access.clinicId, from: scope.from, to: scope.to })
      : null;
    const flagged = all ? await voidedButPaid(c, scope) : [];

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
    return { hasCommission, self, detail, team, net, flagged, names };
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
      flagged={data.flagged}
      names={data.names}
      showTeam={all}
    />
  );
}
