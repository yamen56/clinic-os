import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { AiClient } from "./ai-client";
import { can } from "@/lib/auth";

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
  const canEdit = can(access, "automations");
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
    /*
      Whether the agent can run is a fact about the *worker*, which is where it
      runs — not about this process, which has no reason to hold an Anthropic
      key. Asking our own environment is what told clinics the agent was
      unconfigured while it was answering their patients.

      A worker silent for over five minutes is treated as not ready: its row
      says what it could do when it last spoke, which is not the same as what it
      can do now.
    */
    const worker = (
      await c.query(
        `select ai_ready, updated_at > now() - interval '5 minutes' as alive
           from worker_status where id = true`
      )
    ).rows[0] as { ai_ready: boolean; alive: boolean } | undefined;
    return { agent, knowledge, usage, waConnected, worker };
  });

  return (
    <AiClient
      slug={slug}
      hasApiKey={
        data.worker
          ? data.worker.ai_ready && data.worker.alive
          : // No worker has ever reported in — a fresh database, or local dev
            // where the worker may not be running. Fall back to this process's
            // own key so development is not blocked by a missing heartbeat.
            !!process.env.ANTHROPIC_API_KEY
      }
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
