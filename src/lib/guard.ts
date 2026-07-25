import { redirect } from "next/navigation";
import {
  AuthError,
  requireClinic,
  requireSuperAdmin,
  requireUser,
  type ClinicAccess,
  type SessionInfo,
} from "./auth";

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
