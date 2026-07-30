import type { PoolClient } from "pg";
import type { DocumentEventType } from "./constants";

/**
 * The audit trail.
 *
 * `document_events` is append-only at the database level — a trigger rejects
 * UPDATE and DELETE outright — so this module only ever inserts. Everything
 * that happens to a document goes through here, including the things nobody
 * wants to log: a hash that failed to match, a link that was revoked, a
 * document that was voided.
 */
export async function logDocEvent(
  c: PoolClient,
  e: {
    clinicId: string;
    documentId: string;
    signerId?: string | null;
    type: DocumentEventType;
    actorUserId?: string | null;
    actorKind?: "staff" | "signer" | "system" | "patient";
    ip?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await c.query(
    `insert into document_events
       (clinic_id, document_id, signer_id, event_type, actor_user_id, actor_kind, ip_address, user_agent, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.clinicId,
      e.documentId,
      e.signerId ?? null,
      e.type,
      e.actorUserId ?? null,
      e.actorKind ?? (e.actorUserId ? "staff" : "system"),
      e.ip ?? null,
      // Long enough to identify a device, short enough not to be a storage problem.
      e.userAgent ? e.userAgent.slice(0, 400) : null,
      JSON.stringify(e.metadata ?? {}),
    ]
  );
}

export type DocEvent = {
  id: string;
  event_type: DocumentEventType;
  signer_id: string | null;
  actor_kind: string;
  actor_name: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export async function loadDocEvents(
  c: PoolClient,
  documentId: string,
  clinicId: string
): Promise<DocEvent[]> {
  const r = await c.query(
    `select e.id, e.event_type, e.signer_id, e.actor_kind, e.ip_address, e.user_agent,
            e.metadata, e.created_at,
            coalesce(u.full_name, s.display_name) as actor_name
     from document_events e
     left join users u on u.id = e.actor_user_id
     left join document_signers s on s.id = e.signer_id
     where e.document_id = $1 and e.clinic_id = $2
     order by e.created_at, e.id`,
    [documentId, clinicId]
  );
  return r.rows as DocEvent[];
}

/** The caller's address as our own proxy observed it — see booking-public.clientIp. */
export function requestIp(req: Request): string | null {
  const chain = req.headers.get("x-forwarded-for");
  if (!chain) return req.headers.get("x-real-ip")?.trim() || null;
  const parts = chain.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] || null;
}

export function requestUserAgent(req: Request): string | null {
  return req.headers.get("user-agent");
}

/** "iPhone · Safari" — enough to identify a device on the certificate, no more. */
export function describeDevice(ua: string | null): string {
  if (!ua) return "—";
  const device = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? "Android"
        : /Macintosh/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Unknown device";
  // Order matters: Edge and Chrome both claim Safari, Chrome claims Safari too.
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /OPR\//i.test(ua)
      ? "Opera"
      : /Chrome\//i.test(ua)
        ? "Chrome"
        : /Firefox\//i.test(ua)
          ? "Firefox"
          : /Safari\//i.test(ua)
            ? "Safari"
            : "Browser";
  return `${device} · ${browser}`;
}
