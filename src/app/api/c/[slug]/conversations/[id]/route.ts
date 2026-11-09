import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { apiClinic, inClinic } from "@/lib/clinic-api";
import { owedSql } from "@/lib/invoices";
import { resendMessage } from "@/lib/wa-resend";

/** Thread detail: messages + linked patient panel. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;

  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "conversations");
  if (!g.ok) return g.res;

  const data = await inClinic(g.access, async (c) => {
    const conv = (
      await c.query(
        // The coalesce is listed after cv.* deliberately: it shadows the
        // conversation's own column so callers get the best name available.
        `select cv.*, p.full_name as patient_name, p.status as patient_status, p.tags as patient_tags,
                coalesce(cv.whatsapp_name, p.whatsapp_name) as whatsapp_name,
                au.full_name as assigned_name
         from conversations cv
         left join patients p on p.id = cv.patient_id
         left join users au on au.id = cv.assigned_to
         where cv.id = $1 and cv.clinic_id = $2`,
        [id, g.access.clinicId]
      )
    ).rows[0];
    if (!conv) return null;
    const messages = (
      await c.query(
        `select m.id, m.direction, m.sender_kind, m.msg_type, m.body, m.media_path, m.media_mime,
                m.media_name, m.status, m.error, m.created_at, m.sent_at, m.scheduled_at, m.delivered_at,
                m.resent_at, u.full_name as sender_name
         from messages m left join users u on u.id = m.sender_user_id
         where m.conversation_id = $1 and m.clinic_id = $2
         order by m.created_at desc limit 150`,
        [id, g.access.clinicId]
      )
    ).rows.reverse();
    // Whether a waiting message is waiting on the connection — the commonest
    // reason, and one only the session knows (lib/wa-delivery).
    const ws = (
      await c.query(`select status, paused_until from whatsapp_sessions where clinic_id = $1`, [g.access.clinicId])
    ).rows[0];
    const session = { connected: ws?.status === "connected", pausedUntil: ws?.paused_until ?? null };

    let patient = null;
    if (conv.patient_id) {
      patient = (
        await c.query(
          `select p.id, p.full_name, p.phone_e164, p.tags, p.status, p.birth_date, p.notes_summary,
                  (select starts_at from appointments a where a.patient_id = p.id and a.starts_at > now()
                     and a.status not in ('cancelled') order by starts_at limit 1) as next_appointment,
                  (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
                     where i.patient_id = p.id and ${owedSql("i")}) as balance_due
           from patients p where p.id = $1`,
          [conv.patient_id]
        )
      ).rows[0];
    }
    return { conversation: conv, messages, patient, session };
  });

  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(data);
}

/** Thread commands: read / ai toggle / assign / status. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;

  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "conversations");
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as {
    op?: string;
    enabled?: boolean;
    status?: string;
    messageId?: string;
  };

  if (body.op === "resend") {
    if (!isUuid(body.messageId ?? "")) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const r = await inClinic(g.access, (c) =>
      resendMessage(c, { clinicId: g.access.clinicId, conversationId: id, messageId: body.messageId!, userId: g.access.session.user.id })
    );
    return r.ok ? NextResponse.json(r) : NextResponse.json(r, { status: r.error === "not_found" ? 404 : 409 });
  }

  const ok = await inClinic(g.access, async (c) => {
    if (body.op === "read") {
      await c.query(
        `update conversations set unread_count = 0 where id = $1 and clinic_id = $2`,
        [id, g.access.clinicId]
      );
      // Read here is read on WhatsApp too: the worker sends the receipt (worker/wa/read.ts).
      await c.query(
        `insert into jobs (clinic_id, kind, payload)
         select $1, 'wa:read', $2 where exists (
           select 1 from messages where conversation_id = $3 and direction = 'in' and wa_message_id is not null
              and read_at is null and created_at > now() - interval '7 days')`,
        [g.access.clinicId, JSON.stringify({ conversationId: id }), id]
      );
      return true;
    }
    if (body.op === "ai") {
      await c.query(
        `update conversations set ai_enabled = $3, ai_paused_until = null, flagged = case when $3 then false else flagged end
         where id = $1 and clinic_id = $2`,
        [id, g.access.clinicId, !!body.enabled]
      );
      return true;
    }
    if (body.op === "assign") {
      await c.query(
        `update conversations set assigned_to = $3 where id = $1 and clinic_id = $2`,
        [id, g.access.clinicId, g.access.session.user.id]
      );
      return true;
    }
    /*
      Done: answered, nothing left to do. Closing clears the flag with it — a
      thread somebody has dealt with is not still asking for a person. The
      patient's next message opens it again (worker/wa/inbound).
    */
    if (body.op === "status" && (body.status === "open" || body.status === "closed")) {
      await c.query(
        `update conversations set status = $3,
                flagged = case when $3 = 'closed' then false else flagged end,
                flag_reason = case when $3 = 'closed' then null else flag_reason end
          where id = $1 and clinic_id = $2`,
        [id, g.access.clinicId, body.status]
      );
      return true;
    }
    // The flag handled, the thread still open. It used to clear only by switching the AI on.
    if (body.op === "unflag") {
      await c.query(`update conversations set flagged = false, flag_reason = null where id = $1 and clinic_id = $2`, [id, g.access.clinicId]);
      return true;
    }
    return false;
  });
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "bad_op" }, { status: 400 });
}
