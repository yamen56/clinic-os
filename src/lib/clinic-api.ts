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
    const status = code === "forbidden" ? 403 : code === "suspended" ? 402 : 401;
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
