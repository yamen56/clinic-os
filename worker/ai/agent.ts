import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { DateTime } from "luxon";
import { withSystem } from "../db";
import { buildSystemPrompt, type AgentConfig } from "./prompt";
import { computeSlots } from "../../src/lib/slots";
import { isWithinHours, type WeeklyHours } from "../../src/lib/hours";

/**
 * Per-clinic AI receptionist.
 *
 * Answers only from the clinic's knowledge base plus live calendar availability,
 * books appointments through the phone-identity rule, and hands off to staff on
 * emergencies, complaints, or anything it can't answer.
 */

const MAX_HISTORY = 20;
const MAX_ITERATIONS = 6;

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

type ConversationRow = {
  id: string;
  clinic_id: string;
  patient_id: string | null;
  phone_e164: string;
  ai_enabled: boolean;
  ai_paused_until: string | null;
};

/** Is the AI allowed to answer right now? */
async function shouldRespond(
  c: import("pg").PoolClient,
  conv: ConversationRow
): Promise<{ ok: false; reason: string } | { ok: true; cfg: AgentConfig }> {
  const row = (
    await c.query(
      `select aa.enabled, aa.agent_name, aa.instructions, aa.language_mode, aa.hours_mode,
              aa.custom_hours, aa.escalation_notes, aa.max_daily_messages, aa.model, aa.greeting,
              cl.name, cl.name_ar, cl.timezone, cl.address, cl.address_ar, cl.google_maps_url,
              cl.phone_e164, cl.working_hours, cl.subscription_status
       from ai_agents aa join clinics cl on cl.id = aa.clinic_id
       where aa.clinic_id = $1`,
      [conv.clinic_id]
    )
  ).rows[0];

  if (!row) return { ok: false, reason: "no_agent" };
  if (!row.enabled) return { ok: false, reason: "disabled" };
  if (row.subscription_status === "suspended") return { ok: false, reason: "suspended" };
  if (!conv.ai_enabled) return { ok: false, reason: "thread_off" };
  if (conv.ai_paused_until && new Date(conv.ai_paused_until) > new Date()) {
    return { ok: false, reason: "paused_after_human_reply" };
  }

  // Hours gate
  const now = DateTime.now().setZone(row.timezone);
  const openNow = isWithinHours(row.working_hours as WeeklyHours, now, now.plus({ minutes: 1 }));
  if (row.hours_mode === "after_hours" && openNow) {
    return { ok: false, reason: "clinic_open_staff_handles" };
  }
  if (row.hours_mode === "custom") {
    const custom = row.custom_hours as WeeklyHours;
    if (custom && Object.keys(custom).length && !isWithinHours(custom, now, now.plus({ minutes: 1 }))) {
      return { ok: false, reason: "outside_ai_hours" };
    }
  }

  // Daily cap
  const usage = (
    await c.query(
      `select messages_out from ai_usage where clinic_id = $1 and day = $2`,
      [conv.clinic_id, now.toISODate()]
    )
  ).rows[0];
  if (usage && usage.messages_out >= row.max_daily_messages) {
    return { ok: false, reason: "daily_cap" };
  }

  return {
    ok: true,
    cfg: {
      clinicId: conv.clinic_id,
      clinicName: row.name,
      clinicNameAr: row.name_ar,
      timezone: row.timezone,
      address: row.address,
      addressAr: row.address_ar,
      mapsUrl: row.google_maps_url,
      clinicPhone: row.phone_e164,
      agentName: row.agent_name,
      instructions: row.instructions,
      languageMode: row.language_mode,
      escalationNotes: row.escalation_notes,
      model: row.model || "claude-opus-5",
      greeting: row.greeting,
    },
  };
}

async function flagForStaff(clinicId: string, conversationId: string, reason: string) {
  await withSystem(async (c) => {
    await c.query(
      `update conversations set flagged = true, flag_reason = $2, ai_enabled = false where id = $1`,
      [conversationId, reason.slice(0, 200)]
    );
    const clinic = (await c.query(`select slug from clinics where id = $1`, [clinicId])).rows[0];
    const staff = await c.query(
      `select user_id from clinic_members where clinic_id = $1 and active and role in ('owner', 'receptionist')`,
      [clinicId]
    );
    for (const s of staff.rows) {
      await c.query(
        `insert into notifications (clinic_id, user_id, kind, title, body, url)
         values ($1, $2, 'ai_escalation', $3, $4, $5)`,
        [
          clinicId,
          s.user_id,
          "المساعد الذكي يحتاج تدخلك",
          reason.slice(0, 300),
          `/c/${clinic.slug}/conversations?open=${conversationId}`,
        ]
      );
    }
    await c.query(
      `insert into ai_usage (clinic_id, day, escalations) values ($1, current_date, 1)
       on conflict (clinic_id, day) do update set escalations = ai_usage.escalations + 1`,
      [clinicId]
    );
  });
}

/** Main entry: an inbound patient message arrived on this conversation. */
export async function respondToConversation(conversationId: string): Promise<void> {
  const anthropic = getClient();

  const prep = await withSystem(async (c) => {
    const conv = (
      await c.query(
        `select id, clinic_id, patient_id, phone_e164, ai_enabled, ai_paused_until
         from conversations where id = $1`,
        [conversationId]
      )
    ).rows[0] as ConversationRow | undefined;
    if (!conv) return null;

    const gate = await shouldRespond(c, conv);
    if (!gate.ok) return { skip: gate.reason as string };

    const history = (
      await c.query(
        `select direction, sender_kind, body, msg_type from messages
         where conversation_id = $1 and status <> 'failed'
         order by created_at desc limit $2`,
        [conversationId, MAX_HISTORY]
      )
    ).rows.reverse();

    const system = await buildSystemPrompt(c, gate.cfg);
    return { conv, cfg: gate.cfg, history, system };
  });

  if (!prep) return;
  if ("skip" in prep) {
    console.log(`[ai] skip ${conversationId}: ${prep.skip}`);
    return;
  }
  const { conv, cfg, history, system } = prep;

  if (!anthropic) {
    console.log("[ai] ANTHROPIC_API_KEY not set — escalating to staff instead");
    await flagForStaff(conv.clinic_id, conv.id, "المساعد الذكي غير مفعّل (مفتاح API غير موجود)");
    return;
  }

  // Build the transcript. Media the agent can't read is described, not dropped.
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    const text =
      m.body?.trim() ||
      (m.msg_type !== "text" ? `[the patient sent ${m.msg_type}]` : "");
    if (!text) continue;
    const role = m.direction === "in" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n${text}`;
    } else {
      messages.push({ role, content: text });
    }
  }
  if (!messages.length || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: "مرحبا" });
  }
  if (messages[messages.length - 1].role !== "user") return; // nothing new to answer

  let escalated: string | null = null;
  let booked = false;

  const checkAvailability = betaTool({
    name: "check_availability",
    description:
      "Get real open appointment times from the clinic calendar. Always call this before offering any time to a patient. Returns at most 6 open slots for the requested day.",
    inputSchema: {
      type: "object",
      properties: {
        service_name: {
          type: "string",
          description: "The service the patient wants, exactly as named in the clinic information.",
        },
        date: {
          type: "string",
          description: "Date to check in YYYY-MM-DD format, in clinic local time.",
        },
      },
      required: ["service_name", "date"],
      additionalProperties: false,
    },
    run: async ({ service_name, date }) => {
      return withSystem(async (c) => {
        const svc = (
          await c.query(
            `select id, name, duration_min from services
             where clinic_id = $1 and active and bookable_online
               and (name ilike $2 or name_ar ilike $2)
             limit 1`,
            [cfg.clinicId, `%${service_name}%`]
          )
        ).rows[0];
        if (!svc) {
          const all = (
            await c.query(
              `select name, name_ar from services where clinic_id = $1 and active and bookable_online`,
              [cfg.clinicId]
            )
          ).rows;
          return `No service matches "${service_name}". Available services: ${all
            .map((s) => s.name_ar || s.name)
            .join(", ")}. Ask the patient which one they want.`;
        }
        const clinic = (
          await c.query(
            `select working_hours, blocked_dates, timezone from clinics where id = $1`,
            [cfg.clinicId]
          )
        ).rows[0];
        const link = (
          await c.query(
            `select min_notice_min, slot_granularity_min, max_days_ahead, doctor_member_id
             from booking_links where clinic_id = $1 and active order by created_at limit 1`,
            [cfg.clinicId]
          )
        ).rows[0];

        const day = DateTime.fromISO(date, { zone: clinic.timezone });
        if (!day.isValid) return "That date is not valid. Ask the patient for a clearer day.";
        const today = DateTime.now().setZone(clinic.timezone).startOf("day");
        if (day < today) return "That date is in the past. Ask the patient for an upcoming day.";
        if (day > today.plus({ days: link?.max_days_ahead ?? 30 })) {
          return `The clinic only books up to ${link?.max_days_ahead ?? 30} days ahead.`;
        }

        const slots = await computeSlots(c, {
          clinicId: cfg.clinicId,
          tz: clinic.timezone,
          clinicHours: clinic.working_hours,
          blockedDates: clinic.blocked_dates,
          serviceId: svc.id,
          doctorMemberId: null,
          dateISO: day.toISODate()!,
          minNoticeMin: link?.min_notice_min ?? 120,
          granularityMin: link?.slot_granularity_min ?? 30,
          linkDoctorId: link?.doctor_member_id ?? null,
        });

        if (!slots.length) {
          return `No open times for ${svc.name} on ${day.toFormat("cccc d LLLL")}. Suggest checking another day.`;
        }
        const shown = slots.slice(0, 6).map((s) => {
          const local = DateTime.fromISO(s.startISO).setZone(clinic.timezone);
          return `${local.toFormat("HH:mm")} (start_iso=${s.startISO})`;
        });
        return `Open times for ${svc.name} on ${day.toFormat("cccc d LLLL")}: ${shown.join(", ")}. Offer at most 3 of these. When booking, pass the exact start_iso value.`;
      });
    },
  });

  const bookAppointment = betaTool({
    name: "book_appointment",
    description:
      "Book an appointment for this patient after they agreed to a specific time returned by check_availability.",
    inputSchema: {
      type: "object",
      properties: {
        service_name: { type: "string", description: "Service name as listed in clinic information." },
        start_iso: {
          type: "string",
          description: "The exact start_iso value returned by check_availability for the chosen slot.",
        },
        patient_name: {
          type: "string",
          description: "The patient's name if they gave it; empty string if unknown.",
        },
      },
      required: ["service_name", "start_iso", "patient_name"],
      additionalProperties: false,
    },
    run: async ({ service_name, start_iso, patient_name }) => {
      return withSystem(async (c) => {
        const svc = (
          await c.query(
            `select id, name, duration_min from services
             where clinic_id = $1 and active and (name ilike $2 or name_ar ilike $2) limit 1`,
            [cfg.clinicId, `%${service_name}%`]
          )
        ).rows[0];
        if (!svc) return `No service matches "${service_name}". Do not book; ask the patient to pick a listed service.`;

        const start = DateTime.fromISO(start_iso);
        if (!start.isValid) return "Invalid start time. Call check_availability again and use an exact start_iso.";
        if (start < DateTime.now()) return "That time is in the past. Offer a future slot.";
        const end = start.plus({ minutes: svc.duration_min });

        // Re-verify the slot is still free (another patient may have taken it)
        const clinic = (
          await c.query(`select working_hours, blocked_dates, timezone from clinics where id = $1`, [
            cfg.clinicId,
          ])
        ).rows[0];
        const free = await computeSlots(c, {
          clinicId: cfg.clinicId,
          tz: clinic.timezone,
          clinicHours: clinic.working_hours,
          blockedDates: clinic.blocked_dates,
          serviceId: svc.id,
          doctorMemberId: null,
          dateISO: start.setZone(clinic.timezone).toISODate()!,
          minNoticeMin: 0,
          granularityMin: 15,
          linkDoctorId: null,
        });
        const match = free.find((s) => s.startISO === start.toUTC().toISO());
        if (!match) {
          return "That time was just taken. Call check_availability again and offer the patient a different time.";
        }

        // Patient identity rule: the conversation is already keyed by phone
        let patientId = conv.patient_id;
        if (!patientId) {
          const p = await c.query(
            `insert into patients (clinic_id, full_name, phone_e164, source, status)
             values ($1, $2, $3, 'ai_agent', 'active') returning id`,
            [cfg.clinicId, patient_name?.trim() || conv.phone_e164, conv.phone_e164]
          );
          patientId = p.rows[0].id;
          await c.query(`update conversations set patient_id = $2 where id = $1`, [conv.id, patientId]);
        } else if (patient_name?.trim()) {
          await c.query(
            `update patients set full_name = $2, status = case when status = 'lead' then 'active' else status end
             where id = $1 and (full_name = phone_e164 or full_name = '' or status = 'lead')`,
            [patientId, patient_name.trim()]
          );
        }

        const appt = await c.query(
          `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status, source, notes)
           values ($1, $2, $3, $4, $5, $6, 'scheduled', 'ai_agent', 'Booked by the AI receptionist on WhatsApp')
           returning id`,
          [
            cfg.clinicId, patientId, match.doctorMemberId, svc.id,
            start.toUTC().toISO(), end.toUTC().toISO(),
          ]
        );
        await c.query(
          `insert into jobs (clinic_id, kind, payload) values ($1, 'trigger:appointment_created', $2)`,
          [cfg.clinicId, JSON.stringify({ appointmentId: appt.rows[0].id, patientId, source: "ai_agent" })]
        );
        await c.query(
          `insert into ai_usage (clinic_id, day, bookings) values ($1, current_date, 1)
           on conflict (clinic_id, day) do update set bookings = ai_usage.bookings + 1`,
          [cfg.clinicId]
        );
        const staff = await c.query(
          `select cm.user_id, cl.slug from clinic_members cm join clinics cl on cl.id = cm.clinic_id
           where cm.clinic_id = $1 and cm.active and cm.role in ('owner', 'receptionist')`,
          [cfg.clinicId]
        );
        const local = start.setZone(clinic.timezone).setLocale("ar-JO-u-nu-latn");
        for (const s of staff.rows) {
          await c.query(
            `insert into notifications (clinic_id, user_id, kind, title, body, url)
             values ($1, $2, 'ai_booking', $3, $4, $5)`,
            [
              cfg.clinicId, s.user_id,
              `حجز جديد من المساعد الذكي: ${patient_name?.trim() || conv.phone_e164}`,
              `${svc.name} — ${local.toFormat("cccc d LLLL")} ${local.toFormat("h:mm a")}`,
              `/c/${s.slug}/calendar`,
            ]
          );
        }
        booked = true;
        return `Booked: ${svc.name} on ${local.toFormat("cccc d LLLL")} at ${local.toFormat("h:mm a")}. Confirm this to the patient with the day, date, and time.`;
      });
    },
  });

  const escalate = betaTool({
    name: "escalate_to_human",
    description:
      "Hand this conversation to clinic staff. Use for emergencies, severe symptoms, complaints, an angry patient, a request for a human, or any question you cannot answer from the clinic information.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "One short sentence, in Arabic, telling staff why this needs them.",
        },
        urgent: { type: "boolean", description: "True for a medical emergency or severe distress." },
      },
      required: ["reason", "urgent"],
      additionalProperties: false,
    },
    run: async ({ reason, urgent }) => {
      escalated = `${urgent ? "🚨 عاجل: " : ""}${reason}`;
      return "Staff have been notified. Tell the patient briefly that a team member will follow up shortly, and do not attempt to answer the question yourself.";
    },
  });

  let finalText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: cfg.model,
      max_tokens: 2048,
      system,
      tools: [checkAvailability, bookAppointment, escalate],
      messages,
      // A receptionist turn is short and scoped; low effort keeps WhatsApp replies fast.
      output_config: { effort: "low" },
      max_iterations: MAX_ITERATIONS,
    });

    for await (const message of runner) {
      inputTokens += message.usage?.input_tokens ?? 0;
      outputTokens += message.usage?.output_tokens ?? 0;

      if (message.stop_reason === "refusal") {
        console.log(`[ai] refusal on ${conversationId}`);
        escalated = escalated ?? "المساعد الذكي لم يستطع الرد على هذه الرسالة";
        break;
      }
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) finalText = text;
    }
  } catch (e) {
    console.error(`[ai] failed on ${conversationId}:`, (e as Error).message);
    await flagForStaff(conv.clinic_id, conv.id, "تعذّر على المساعد الذكي معالجة الرسالة");
    return;
  }

  // Queue the reply (labeled as AI so staff can audit it)
  if (finalText) {
    await withSystem(async (c) => {
      await c.query(
        `insert into messages (clinic_id, conversation_id, direction, sender_kind, msg_type, body, status)
         values ($1, $2, 'out', 'ai', 'text', $3, 'queued')`,
        [conv.clinic_id, conv.id, finalText]
      );
      await c.query(
        `update conversations set last_message_at = now(), last_message_preview = $2, last_message_direction = 'out'
         where id = $1`,
        [conv.id, finalText.slice(0, 120)]
      );
      await c.query(
        `insert into ai_conversation_state (conversation_id, clinic_id, state, last_ai_message_at)
         values ($1, $2, '{}', now())
         on conflict (conversation_id) do update set last_ai_message_at = now()`,
        [conv.id, conv.clinic_id]
      );
      await c.query(
        `insert into ai_usage (clinic_id, day, messages_out, input_tokens, output_tokens)
         values ($1, current_date, 1, $2, $3)
         on conflict (clinic_id, day) do update set
           messages_out = ai_usage.messages_out + 1,
           input_tokens = ai_usage.input_tokens + $2,
           output_tokens = ai_usage.output_tokens + $3`,
        [conv.clinic_id, inputTokens, outputTokens]
      );
    });
  }

  if (escalated) {
    await flagForStaff(conv.clinic_id, conv.id, escalated);
  }

  console.log(
    `[ai] ${conversationId}: replied=${!!finalText} booked=${booked} escalated=${!!escalated} tokens=${inputTokens}/${outputTokens}`
  );
}
