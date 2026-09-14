import { cache } from "react";
import { requireClinic, hasFullControl } from "./auth";
import { inClinic } from "./clinic-api";
import { memberHasEarnings } from "./earnings";
import type { FinanceViewer } from "./finance";

/**
 * What this member may open in the money section, resolved once per request.
 *
 * Split from `lib/finance` because that one is imported by the tab strip, which
 * is a client component: a database import there would be a build error at
 * best and a leaked query at worst.
 *
 * `cache` is doing real work rather than tidying. Three readers want the same
 * answer on the same request — the section layout draws the strip from it, the
 * earnings page gates itself on it, and neither may take the other's word for
 * it, because a layout in this framework is not a gate: Next starts rendering
 * the page concurrently, so a `redirect()` up here does not stop the page below
 * from having already run its queries. Keyed on the slug rather than on the
 * access object, which `requireClinic` rebuilds per call and would defeat it.
 */
export const financeViewer = cache(async (slug: string): Promise<FinanceViewer> => {
  const access = await requireClinic(slug);
  /*
    Only asked when it can change an answer. Every doctor holds `earnings` and
    almost nobody else does, so reception pays nothing for this and a doctor
    pays one indexed existence check — against the alternative of threading the
    fact down from the clinic layout, which a nested layout cannot receive.
  */
  const hasEarnings = access.caps.earnings
    ? await inClinic(access, (c) => memberHasEarnings(c, access.clinicId, access.memberId))
    : false;
  return { caps: access.caps, hasEarnings, fullControl: hasFullControl(access) };
});
