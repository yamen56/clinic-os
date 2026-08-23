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
  return (await staffMembersInRoles(c, clinicId, roles)).map((m) => m.userId);
}

export type StaffMember = { memberId: string; userId: string; role: string; isOwner: boolean };

/**
 * The same audience, with the membership kept.
 *
 * The morning digest needs to know which of the recipients is a doctor, because
 * a doctor is sent their own list and everybody else is sent the clinic's — and
 * that question is about the membership row, not the user.
 */
export async function staffMembersInRoles(
  c: PoolClient,
  clinicId: string,
  roles: readonly string[]
): Promise<StaffMember[]> {
  const wantsOwner = roles.includes("owner");
  const jobs = roles.filter((r) => r !== "owner");
  const r = await c.query(
    `select id, user_id, role, is_owner from clinic_members
      where clinic_id = $1 and active and (($2 and is_owner) or role = any($3))`,
    [clinicId, wantsOwner, jobs]
  );
  return r.rows.map((x) => ({
    memberId: x.id as string,
    userId: x.user_id as string,
    role: x.role as string,
    isOwner: x.is_owner as boolean,
  }));
}

/**
 * In-app notifications for clinic staff. Push delivery is layered on top by
 * the worker (it watches the notifications table and sends web push).
 */
/**
 * `dedupeKey` makes a notification at-most-once.
 *
 * Pass one whenever repeating would be noise rather than news: a reminder for a
 * particular appointment, an alert about a condition that is still true. The key
 * is namespaced per recipient here, because each member gets their own row and
 * one person having already been told must not silence the others.
 *
 * Leave it out where a repeat is genuinely a new event — a second document
 * signed, another escalation — and the insert behaves as it always did.
 */
async function insertNotification(
  c: PoolClient,
  clinicId: string | null,
  userId: string,
  n: { kind: string; title: string; body?: string; url?: string; dedupeKey?: string }
) {
  await c.query(
    `insert into notifications (clinic_id, user_id, kind, title, body, url, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7)
     -- The index is partial (only keyed rows), so the predicate has to be
     -- repeated here or Postgres cannot infer which index this refers to.
     on conflict (dedupe_key) where dedupe_key is not null do nothing`,
    [
      clinicId,
      userId,
      n.kind,
      n.title,
      n.body ?? "",
      n.url ?? null,
      n.dedupeKey ? `${n.dedupeKey}:${userId}` : null,
    ]
  );
}

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
    /** Set to make this notification at-most-once. See insertNotification. */
    dedupeKey?: string;
  }
) {
  let userIds = n.userIds;
  if (!userIds) {
    userIds = await staffInRoles(c, clinicId, n.roles ?? ["owner", "receptionist"]);
  }
  for (const uid of userIds) await insertNotification(c, clinicId, uid, n);
}

export async function notifyUser(
  c: PoolClient,
  userId: string,
  n: {
    clinicId?: string | null;
    kind: string;
    title: string;
    body?: string;
    url?: string;
    dedupeKey?: string;
  }
) {
  await insertNotification(c, n.clinicId ?? null, userId, n);
}
