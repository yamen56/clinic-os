import { NextResponse } from "next/server";
import { AuthError, can, requireClinic, type ClinicAccess } from "./auth";
import { withCtx } from "./db";
import type { Capability } from "./permissions";
import type { PoolClient } from "pg";

/**
 * Route-handler guard: resolves clinic access or returns an error response.
 *
 * `need` is the same gate the matching page applies, and passing it is not
 * optional politeness — the nav hides a section a member may not use, but the
 * endpoint behind it stays reachable by URL. A route that only proves
 * membership is a route every member of the clinic can call, whatever their
 * access says, which is how a receptionist with the patient list switched off
 * reads the whole patient list anyway.
 *
 * An array means *any of* — `patients/search` backs the calendar, the invoice
 * builder and the automation editor as well as the patient list, so the
 * question it has to answer is "may this person look a patient up at all",
 * not "may they open the patients screen".
 */
export async function apiClinic(
  slug: string,
  need?: Capability | Capability[]
): Promise<{ ok: true; access: ClinicAccess } | { ok: false; res: NextResponse }> {
  let access: ClinicAccess;
  try {
    access = await requireClinic(slug);
  } catch (e) {
    const code = e instanceof AuthError ? e.code : "unauthenticated";
    /*
      403 for a deleted clinic, not 401. A 401 tells the client its credentials
      are stale and to try again with better ones, which would send an
      already-signed-in browser round the login loop; the credentials are fine,
      the clinic is gone.
    */
    const status =
      code === "forbidden" || code === "deleted" ? 403 : code === "suspended" ? 402 : 401;
    return { ok: false, res: NextResponse.json({ error: code }, { status }) };
  }

  if (need) {
    const wanted = Array.isArray(need) ? need : [need];
    if (!wanted.some((cap) => can(access, cap))) {
      return { ok: false, res: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    }
  }
  return { ok: true, access };
}

/** Runs fn in the RLS context of the given clinic access. */
export function inClinic<T>(access: ClinicAccess, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withCtx(
    {
      userId: access.session.user.id,
      clinicId: access.clinicId,
      role: access.role,
      isAdmin: access.session.user.isSuperAdmin,
    },
    fn
  );
}
