import { redirect } from "next/navigation";
import {
  AuthError,
  can,
  requireAdminCap,
  requireClinic,
  requireSuperAdmin,
  requireUser,
  type ClinicAccess,
  type SessionInfo,
} from "./auth";
import type { Capability } from "./permissions";
import type { AdminCapability } from "./admin-permissions";

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

/**
 * An admin page that needs a specific agency capability. Sends anyone without
 * it back to the clinic list, which every admin can see — the same rule as
 * `guardCap`, and for the same reason.
 */
export async function guardAdminCap(cap: AdminCapability): Promise<SessionInfo> {
  try {
    return await requireAdminCap(cap);
  } catch (e) {
    if (e instanceof AuthError && e.code === "forbidden") {
      const s = await requireUser().catch(() => null);
      redirect(s?.user.isSuperAdmin ? "/admin" : "/");
    }
    redirect("/login");
  }
}

/**
 * An admin page built from independently-gated sections.
 *
 * The seeded-defaults page holds the automation recipes, the knowledge starters
 * and the document library, and a clinic-content person may hold `documents`
 * without holding `defaults`. Guarding on one capability would shut them out of
 * the only screen their own work now lives on, so the door opens for any of
 * them and each section checks for itself.
 */
export async function guardAdminAnyCap(...caps: AdminCapability[]): Promise<SessionInfo> {
  const s = await guardAdmin();
  if (!caps.some((c) => s.adminCaps[c])) redirect("/admin");
  return s;
}

export async function guardClinic(slug: string): Promise<ClinicAccess> {
  try {
    return await requireClinic(slug);
  } catch (e) {
    if (e instanceof AuthError) {
      // Same page, different sentence: one is a bill to settle, the other is a
      // workspace that is not coming back unless the agency restores it.
      if (e.code === "deleted") redirect("/suspended?removed=1");
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
