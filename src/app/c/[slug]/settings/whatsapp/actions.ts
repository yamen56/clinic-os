"use server";

import { requireClinic, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";

import { internalSecret } from "@/lib/internal-secret";

const WORKER_URL = process.env.WORKER_URL || "http://localhost:4020";
const SECRET = () => internalSecret();

export async function whatsappControlAction(
  slug: string,
  op: "connect" | "disconnect"
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!can(access, "settings")) return { error: "forbidden" };
  try {
    const res = await fetch(`${WORKER_URL}/sessions/${access.clinicId}/${op}`, {
      method: "POST",
      headers: { "x-internal-secret": SECRET() },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: "worker_error" };
  } catch {
    return { error: "worker_down" };
  }
  await inClinic(access, (c) =>
    audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: `whatsapp.${op}`,
      entity: "whatsapp_session",
      entityId: access.clinicId,
    })
  );
  return {};
}
