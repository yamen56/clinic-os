import { DateTime } from "luxon";
import type { PoolClient } from "pg";

export type AgentConfig = {
  clinicId: string;
  clinicName: string;
  clinicNameAr: string | null;
  timezone: string;
  address: string | null;
  addressAr: string | null;
  mapsUrl: string | null;
  clinicPhone: string | null;
  agentName: string;
  instructions: string;
  languageMode: "match" | "ar" | "en";
  escalationNotes: string;
  model: string;
  greeting: string;
};

/**
 * Builds the system prompt. The agent answers ONLY from the clinic's knowledge
 * base plus live calendar availability — never from general knowledge.
 */
export async function buildSystemPrompt(
  c: PoolClient,
  cfg: AgentConfig
): Promise<string> {
  const knowledge = (
    await c.query(
      `select category, title, content from ai_knowledge_items
       where clinic_id = $1 and active and content <> '' order by category, sort`,
      [cfg.clinicId]
    )
  ).rows as { category: string; title: string; content: string }[];

  const services = (
    await c.query(
      `select name, name_ar, duration_min, price from services
       where clinic_id = $1 and active and bookable_online order by sort, name`,
      [cfg.clinicId]
    )
  ).rows;

  const doctors = (
    await c.query(
      `select u.full_name, cm.title, cm.specialty from clinic_members cm
       join users u on u.id = cm.user_id
       where cm.clinic_id = $1 and cm.role = 'doctor' and cm.active order by u.full_name`,
      [cfg.clinicId]
    )
  ).rows;

  const clinic = (
    await c.query(`select working_hours, currency from clinics where id = $1`, [cfg.clinicId])
  ).rows[0];

  const now = DateTime.now().setZone(cfg.timezone);
  const name = cfg.clinicNameAr || cfg.clinicName;

  const lines: string[] = [];
  lines.push(
    `You are ${cfg.agentName || "the receptionist"}, the WhatsApp receptionist for ${name}, a medical clinic.`,
    `Current date and time at the clinic: ${now.toFormat("cccc d LLLL yyyy, h:mm a")} (${cfg.timezone}).`,
    ""
  );

  if (cfg.languageMode === "match") {
    lines.push(
      "LANGUAGE: Reply in the same language the patient writes in. When they write Arabic, use natural Jordanian dialect — warm and simple, the way a real clinic receptionist in Amman talks. Never mix languages in one reply."
    );
  } else if (cfg.languageMode === "ar") {
    lines.push("LANGUAGE: Always reply in natural Jordanian Arabic dialect.");
  } else {
    lines.push("LANGUAGE: Always reply in English.");
  }
  lines.push("");

  lines.push(
    "HARD RULES — these override everything else:",
    "1. Never give medical advice, diagnoses, treatment recommendations, or opinions about symptoms. If a patient describes symptoms or asks anything clinical, tell them the doctor will advise during the visit and offer to book an appointment.",
    "2. Never invent information. Prices, hours, services, doctors, insurance, and locations come ONLY from the CLINIC INFORMATION below. If something is not listed there, say a team member will follow up shortly, and use the escalate_to_human tool.",
    "3. Never promise anything about results, costs beyond the listed price, or insurance coverage that is not written below.",
    "4. Use escalate_to_human immediately for: a medical emergency, severe pain or bleeding, a complaint or angry patient, a request to speak to a human, or anything you cannot answer from the information below.",
    "5. Keep replies short — WhatsApp length, one to three sentences. No bullet lists unless listing available times. No markdown formatting.",
    ""
  );

  if (cfg.instructions.trim()) {
    lines.push("CLINIC-SPECIFIC INSTRUCTIONS:", cfg.instructions.trim(), "");
  }

  lines.push("CLINIC INFORMATION (your only source of truth):");
  lines.push(`- Clinic name: ${cfg.clinicName}${cfg.clinicNameAr ? ` / ${cfg.clinicNameAr}` : ""}`);
  if (cfg.address || cfg.addressAr) lines.push(`- Address: ${cfg.addressAr || cfg.address}`);
  if (cfg.mapsUrl) lines.push(`- Map link: ${cfg.mapsUrl}`);
  if (cfg.clinicPhone) lines.push(`- Clinic phone: ${cfg.clinicPhone}`);

  const wh = clinic.working_hours as Record<string, [string, string][]>;
  const dayNames: Record<string, string> = {
    sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday",
    thu: "Thursday", fri: "Friday", sat: "Saturday",
  };
  const hoursLines = Object.entries(dayNames).map(([k, label]) => {
    const ranges = wh?.[k] ?? [];
    return `  ${label}: ${ranges.length ? ranges.map((r) => `${r[0]}–${r[1]}`).join(", ") : "closed"}`;
  });
  lines.push("- Working hours:", ...hoursLines);

  if (services.length) {
    lines.push("- Services (name, duration, price):");
    for (const s of services) {
      const n = s.name_ar ? `${s.name} / ${s.name_ar}` : s.name;
      lines.push(
        `  ${n} — ${s.duration_min} min${Number(s.price) > 0 ? ` — ${Number(s.price).toFixed(2)} ${clinic.currency}` : ""}`
      );
    }
  }

  if (doctors.length) {
    lines.push("- Doctors:");
    for (const d of doctors) {
      lines.push(`  ${d.title ? `${d.title} ` : ""}${d.full_name}${d.specialty ? ` — ${d.specialty}` : ""}`);
    }
  }

  if (knowledge.length) {
    lines.push("", "ADDITIONAL CLINIC KNOWLEDGE:");
    for (const k of knowledge) {
      lines.push(`- ${k.title}: ${k.content}`);
    }
  }

  lines.push(
    "",
    "BOOKING:",
    "Use check_availability to get real open times before offering any. Offer at most 3 concrete options. Never invent a time or claim a slot is free without checking.",
    "When the patient agrees to a specific time, call book_appointment with that exact time, then confirm the booking in your reply with the day, date, and time.",
    "If the patient's requested day has nothing free, say so plainly and offer the nearest alternatives you actually checked."
  );

  if (cfg.escalationNotes.trim()) {
    lines.push("", "ESCALATION NOTES:", cfg.escalationNotes.trim());
  }

  return lines.join("\n");
}
