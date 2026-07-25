"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, hashPassword } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { z } from "zod";

const addStaffSchema = z.object({
  fullName: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["owner", "doctor", "receptionist"]),
  title: z.string().max(60).optional().default(""),
  specialty: z.string().max(60).optional().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0f6e5c"),
});

export async function addStaffAction(
  slug: string,
  data: unknown
): Promise<{ error?: string; existing?: boolean }> {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return { error: "forbidden" };
  const parsed = addStaffSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  return inClinic(access, async (c) => {
    const existing = await c.query(`select id from users where lower(email) = $1`, [
      d.email.toLowerCase(),
    ]);
    let userId: string;
    let wasExisting = false;
    if (existing.rowCount) {
      userId = existing.rows[0].id;
      wasExisting = true;
    } else {
      const u = await c.query(
        `insert into users (email, password_hash, full_name) values ($1, $2, $3) returning id`,
        [d.email, hashPassword(d.password), d.fullName]
      );
      userId = u.rows[0].id;
    }
    const dup = await c.query(
      `select id from clinic_members where clinic_id = $1 and user_id = $2`,
      [access.clinicId, userId]
    );
    if (dup.rowCount) {
      await c.query(`update clinic_members set active = true, role = $3 where id = $1 and clinic_id = $2`, [
        dup.rows[0].id,
        access.clinicId,
        d.role,
      ]);
    } else {
      await c.query(
        `insert into clinic_members (clinic_id, user_id, role, title, specialty, color)
         values ($1, $2, $3, $4, $5, $6)`,
        [access.clinicId, userId, d.role, d.title, d.specialty, d.color]
      );
    }
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "staff.add",
      entity: "user",
      entityId: userId,
      detail: { role: d.role, email: d.email },
    });
    revalidatePath(`/c/${slug}/settings/staff`);
    return { existing: wasExisting };
  });
}

export async function updateMemberAction(
  slug: string,
  memberId: string,
  patch: {
    role?: string;
    title?: string;
    specialty?: string;
    color?: string;
    active?: boolean;
    reminderMinutes?: number;
    permissions?: Record<string, boolean>;
    workingHours?: Record<string, [string, string][]> | null;
  }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (access.role !== "owner") return { error: "forbidden" };

  return inClinic(access, async (c) => {
    const sets: string[] = [];
    const vals: unknown[] = [memberId, access.clinicId];
    const push = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.role && ["owner", "doctor", "receptionist"].includes(patch.role)) push("role", patch.role);
    if (patch.title !== undefined) push("title", patch.title.slice(0, 60));
    if (patch.specialty !== undefined) push("specialty", patch.specialty.slice(0, 60));
    if (patch.color && /^#[0-9a-fA-F]{6}$/.test(patch.color)) push("color", patch.color);
    if (patch.active !== undefined) push("active", patch.active);
    if (patch.reminderMinutes !== undefined && patch.reminderMinutes >= 0)
      push("reminder_minutes", Math.min(patch.reminderMinutes, 1440));
    if (patch.permissions !== undefined) push("permissions", JSON.stringify(patch.permissions));
    if (patch.workingHours !== undefined)
      push("working_hours", patch.workingHours ? JSON.stringify(patch.workingHours) : null);
    if (!sets.length) return {};
    const r = await c.query(
      `update clinic_members set ${sets.join(", ")} where id = $1 and clinic_id = $2`,
      vals
    );
    if (!r.rowCount) return { error: "not_found" };
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "staff.update",
      entity: "clinic_member",
      entityId: memberId,
      detail: { fields: Object.keys(patch) },
    });
    revalidatePath(`/c/${slug}/settings/staff`);
    return {};
  });
}
