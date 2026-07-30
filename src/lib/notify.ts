import type { PoolClient } from "pg";

/**
 * Resolves a notification audience.
 *
 * "owner" is still spelled like a role by every caller, but it stopped being one
 * when access split from job title — it is a flag on the membership now, and a
 * doctor or a receptionist can be the owner. Left as a plain `role = any(...)`
 * this query would quietly match nobody for "owner", and the person in charge
 * would stop hearing about escalations without any error to notice.
 */
export async function staffInRoles(
  c: PoolClient,
  clinicId: string,
  roles: readonly string[]
): Promise<string[]> {
  const wantsOwner = roles.includes("owner");
  const jobs = roles.filter((r) => r !== "owner");
  const r = await c.query(
    `select user_id from clinic_members
      where clinic_id = $1 and active and (($2 and is_owner) or role = any($3))`,
    [clinicId, wantsOwner, jobs]
  );
  return r.rows.map((x) => x.user_id as string);
}

/**
 * In-app notifications for clinic staff. Push delivery is layered on top by
 * the worker (it watches the notifications table and sends web push).
 */
export async function notifyClinicStaff(
  c: PoolClient,
  clinicId: string,
  n: {
    kind: string;
    title: string;
    body?: string;
    url?: string;
    roles?: ("owner" | "doctor" | "receptionist")[];
    userIds?: string[];
  }
) {
  let userIds = n.userIds;
  if (!userIds) {
    userIds = await staffInRoles(c, clinicId, n.roles ?? ["owner", "receptionist"]);
  }
  for (const uid of userIds) {
    await c.query(
      `insert into notifications (clinic_id, user_id, kind, title, body, url)
       values ($1, $2, $3, $4, $5, $6)`,
      [clinicId, uid, n.kind, n.title, n.body ?? "", n.url ?? null]
    );
  }
}

export async function notifyUser(
  c: PoolClient,
  userId: string,
  n: { clinicId?: string | null; kind: string; title: string; body?: string; url?: string }
) {
  await c.query(
    `insert into notifications (clinic_id, user_id, kind, title, body, url)
     values ($1, $2, $3, $4, $5, $6)`,
    [n.clinicId ?? null, userId, n.kind, n.title, n.body ?? "", n.url ?? null]
  );
}
