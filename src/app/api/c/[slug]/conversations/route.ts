import { NextResponse } from "next/server";
import { apiClinic, inClinic } from "@/lib/clinic-api";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const url = new URL(req.url);
  const filter = url.searchParams.get("filter") ?? "all";
  const q = url.searchParams.get("q")?.trim() ?? "";

  const rows = await inClinic(g.access, async (c) => {
    const conds = ["cv.clinic_id = $1"];
    const vals: unknown[] = [g.access.clinicId];
    if (filter === "unassigned") conds.push("cv.assigned_to is null", "cv.status = 'open'");
    if (filter === "mine") {
      vals.push(g.access.session.user.id);
      conds.push(`cv.assigned_to = $${vals.length}`);
    }
    if (filter === "ai") conds.push("cv.ai_enabled", "(cv.ai_paused_until is null or cv.ai_paused_until < now())");
    if (filter === "flagged") conds.push("cv.flagged");
    if (q) {
      vals.push(`%${q}%`);
      const idx = vals.length;
      vals.push(`%${q.replace(/\D/g, "")}%`);
      // Same Arabic-insensitive matching as the patient list, so searching the
      // inbox for a name behaves the way searching Patients does.
      conds.push(
        `(ar_normalize(p.full_name) like ar_normalize($${idx}) or cv.phone_e164 like $${idx + 1})`
      );
    }
    const r = await c.query(
      `select cv.id, cv.phone_e164, cv.status, cv.assigned_to, cv.ai_enabled, cv.ai_paused_until,
              cv.unread_count, cv.flagged, cv.flag_reason, cv.last_message_at, cv.last_message_preview,
              cv.last_message_direction, cv.patient_id,
              p.full_name as patient_name, p.status as patient_status,
              -- The thread's own name first: most senders have no patient file.
              coalesce(cv.whatsapp_name, p.whatsapp_name) as whatsapp_name,
              au.full_name as assigned_name
       from conversations cv
       left join patients p on p.id = cv.patient_id
       left join users au on au.id = cv.assigned_to
       where ${conds.join(" and ")}
       order by cv.last_message_at desc nulls last
       limit 100`,
      vals
    );
    return r.rows;
  });
  return NextResponse.json({ conversations: rows });
}
