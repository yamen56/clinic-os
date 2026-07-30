import { redirect } from "next/navigation";
import {
  AuthError,
  can,
  requireClinic,
  requireSuperAdmin,
  requireUser,
  type ClinicAccess,
  type SessionInfo,
} from "./auth";
import type { Capability } from "./permissions";

/** Page-level guards: translate auth failures into redirects. */

export async function guardUser(): Promise<SessionInfo> {
  try {
    return await requireUser();
  } catch {
    redirect("/login");
  }
}

export async function guardAdmin(): Promise<SessionInfo> {
  try {
    return await requireSuperAdmin();
  } catch (e) {
    if (e instanceof AuthError && e.code === "forbidden") redirect("/");
    redirect("/login");
  }
}

export async function guardClinic(slug: string): Promise<ClinicAccess> {
  try {
    return await requireClinic(slug);
  } catch (e) {
    if (e instanceof AuthError) {
      if (e.code === "suspended") redirect("/suspended");
      if (e.code === "forbidden") redirect("/");
    }
    redirect("/login");
  }
}

/**
 * A page that needs a capability. Sends anyone without it to the dashboard,
 * which every member can see — bouncing to a screen they also lack would loop.
 */
export async function guardCap(slug: string, cap: Capability): Promise<ClinicAccess> {
  const access = await guardClinic(slug);
  if (!can(access, cap)) redirect(`/c/${slug}`);
  return access;
}
