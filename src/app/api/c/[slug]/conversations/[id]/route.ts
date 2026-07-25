import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";

/** Thread detail: messages + linked patient panel. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;

  const data = await inClinic(g.access, async (c) => {
    const conv = (
      await c.query(
        `select cv.*, p.full_name as patient_name, p.status as patient_status, p.tags as patient_tags,
                p.whatsapp_name, au.full_name as assigned_name
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
                m.media_name, m.status, m.error, m.created_at, m.sent_at, u.full_name as sender_name
         from messages m left join users u on u.id = m.sender_user_id
         where m.conversation_id = $1 and m.clinic_id = $2
         order by m.created_at desc limit 150`,
        [id, g.access.clinicId]
      )
    ).rows.reverse();

    let patient = null;
    if (conv.patient_id) {
      patient = (
        await c.query(
          `select p.id, p.full_name, p.phone_e164, p.tags, p.status, p.birth_date, p.notes_summary,
                  (select starts_at from appointments a where a.patient_id = p.id and a.starts_at > now()
                     and a.status not in ('cancelled') order by starts_at limit 1) as next_appointment,
                  (select coalesce(sum(total - amount_paid), 0) from invoices i
                     where i.patient_id = p.id and i.status in ('sent', 'partially_paid')) as balance_due
           from patients p where p.id = $1`,
          [conv.patient_id]
        )
      ).rows[0];
    }
    return { conversation: conv, messages, patient };
  });

  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(data);
}

/** Thread commands: read / ai toggle / assign / status. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => ({}))) as {
    op?: string;
    enabled?: boolean;
    status?: string;
  };

  const ok = await inClinic(g.access, async (c) => {
    if (body.op === "read") {
      await c.query(
        `update conversations set unread_count = 0 where id = $1 and clinic_id = $2`,
        [id, g.access.clinicId]
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
    if (body.op === "status" && (body.status === "open" || body.status === "closed")) {
      await c.query(`update conversations set status = $3 where id = $1 and clinic_id = $2`, [
        id,
        g.access.clinicId,
        body.status,
      ]);
      return true;
    }
    return false;
  });
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "bad_op" }, { status: 400 });
}
