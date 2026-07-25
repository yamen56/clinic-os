import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { AiClient } from "./ai-client";

export default async function AiAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await guardClinic(slug);
  const canEdit = access.role === "owner" || access.permissions.automations === true;
  if (!canEdit) redirect(`/c/${slug}`);

  const data = await inClinic(access, async (c) => {
    const agent = (
      await c.query(
        `insert into ai_agents (clinic_id) values ($1)
         on conflict (clinic_id) do update set clinic_id = excluded.clinic_id
         returning enabled, agent_name, instructions, language_mode, hours_mode, custom_hours,
                   escalation_notes, max_daily_messages, model`,
        [access.clinicId]
      )
    ).rows[0];
    const knowledge = (
      await c.query(
        `select id, category, title, content, active from ai_knowledge_items
         where clinic_id = $1 order by sort, created_at`,
        [access.clinicId]
      )
    ).rows;
    const usage = (
      await c.query(
        `select day, messages_out, bookings, escalations, input_tokens, output_tokens
         from ai_usage where clinic_id = $1 and day > current_date - 30 order by day desc`,
        [access.clinicId]
      )
    ).rows;
    const waConnected = (
      await c.query(
        `select coalesce(status = 'connected', false) as ok from whatsapp_sessions where clinic_id = $1`,
        [access.clinicId]
      )
    ).rows[0]?.ok ?? false;
    return { agent, knowledge, usage, waConnected };
  });

  return (
    <AiClient
      slug={slug}
      hasApiKey={!!process.env.ANTHROPIC_API_KEY}
      waConnected={data.waConnected}
      initialTab={
        sp.tab === "knowledge" || sp.tab === "usage" ? sp.tab : "setup"
      }
      agent={JSON.parse(JSON.stringify(data.agent))}
      knowledge={JSON.parse(JSON.stringify(data.knowledge))}
      usage={JSON.parse(JSON.stringify(data.usage))}
    />
  );
}
