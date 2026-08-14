"use server";

import { revalidatePath } from "next/cache";
import { requireClinic, type ClinicAccess, can } from "@/lib/auth";
import { inClinic } from "@/lib/clinic-api";
import { audit } from "@/lib/audit";
import { z } from "zod";

function canEdit(access: ClinicAccess): boolean {
  return can(access, "ai");
}

const settingsSchema = z.object({
  enabled: z.boolean(),
  agentName: z.string().max(60).default(""),
  instructions: z.string().max(4000).default(""),
  languageMode: z.enum(["match", "ar", "en"]),
  hoursMode: z.enum(["always", "after_hours", "custom"]),
  customHours: z.record(z.string(), z.unknown()).default({}),
  escalationNotes: z.string().max(2000).default(""),
  maxDailyMessages: z.coerce.number().int().min(1).max(5000),
  model: z.string().max(60).default("claude-opus-5"),
});

export async function saveAiSettingsAction(
  slug: string,
  data: unknown
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  const parsed = settingsSchema.safeParse(data);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;

  await inClinic(access, async (c) => {
    await c.query(
      `insert into ai_agents (clinic_id, enabled, agent_name, instructions, language_mode,
                              hours_mode, custom_hours, escalation_notes, max_daily_messages, model)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (clinic_id) do update set
         enabled = excluded.enabled, agent_name = excluded.agent_name,
         instructions = excluded.instructions, language_mode = excluded.language_mode,
         hours_mode = excluded.hours_mode, custom_hours = excluded.custom_hours,
         escalation_notes = excluded.escalation_notes,
         max_daily_messages = excluded.max_daily_messages, model = excluded.model`,
      [
        access.clinicId, d.enabled, d.agentName, d.instructions, d.languageMode,
        d.hoursMode, JSON.stringify(d.customHours), d.escalationNotes,
        d.maxDailyMessages, d.model,
      ]
    );
    await audit(c, {
      clinicId: access.clinicId,
      userId: access.session.user.id,
      impersonatedBy: access.session.impersonatedBy,
      action: "ai.settings.update",
      entity: "ai_agent",
      entityId: access.clinicId,
      detail: { enabled: d.enabled, hoursMode: d.hoursMode },
    });
  });
  revalidatePath(`/c/${slug}/ai`);
  return {};
}

export async function saveKnowledgeItemAction(
  slug: string,
  item: { id?: string; category: string; title: string; content: string }
): Promise<{ error?: string }> {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return { error: "forbidden" };
  const cats = [
    "services_prices", "doctors", "hours", "location",
    "insurance", "preparation", "faq", "other",
  ];
  if (!cats.includes(item.category) || !item.title.trim()) return { error: "invalid" };

  await inClinic(access, async (c) => {
    if (item.id) {
      await c.query(
        `update ai_knowledge_items set category = $3, title = $4, content = $5
         where id = $1 and clinic_id = $2`,
        [item.id, access.clinicId, item.category, item.title.trim().slice(0, 120), item.content.slice(0, 4000)]
      );
    } else {
      await c.query(
        `insert into ai_knowledge_items (clinic_id, category, title, content, sort)
         values ($1, $2, $3, $4, (select coalesce(max(sort), 0) + 1 from ai_knowledge_items where clinic_id = $1))`,
        [access.clinicId, item.category, item.title.trim().slice(0, 120), item.content.slice(0, 4000)]
      );
    }
  });
  revalidatePath(`/c/${slug}/ai`);
  return {};
}

export async function deleteKnowledgeItemAction(slug: string, id: string) {
  const access = await requireClinic(slug);
  if (!canEdit(access)) return;
  await inClinic(access, (c) =>
    c.query(`delete from ai_knowledge_items where id = $1 and clinic_id = $2`, [id, access.clinicId])
  );
  revalidatePath(`/c/${slug}/ai`);
}
