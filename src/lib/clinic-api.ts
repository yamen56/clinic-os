import { NextResponse } from "next/server";
import { AuthError, requireClinic, type ClinicAccess } from "./auth";
import { withCtx } from "./db";
import type { PoolClient } from "pg";

/** Route-handler guard: resolves clinic access or returns an error response. */
export async function apiClinic(slug: string): Promise<
  | { ok: true; access: ClinicAccess }
  | { ok: false; res: NextResponse }
> {
  try {
    const access = await requireClinic(slug);
    return { ok: true, access };
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
