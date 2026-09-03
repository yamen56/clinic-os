import type { PoolClient } from "pg";
import { RECIPES_ON_BY_DEFAULT } from "./esign/constants";
import { seedStaffAlerts } from "./staff-alerts";
import { toFeatureSetting, allFeatures, type FeatureMap } from "./features";
import type { Specialty } from "./specialties";

/**
 * Everything a clinic needs to exist, in one place.
 *
 * This used to live inside `createClinicAction`, which was fine while the admin
 * form was the only way a clinic came into being. It is not any more: Clinicti
 * runs its own workspace inside the product, and that workspace is created by a
 * script rather than by somebody filling in a form.
 *
 * Two provisioning paths would drift — one of them would gain the note
 * categories and the other would not, and the symptom months later would be a
 * workspace whose notes screen throws because `note_categories` is empty. So
 * there is one path, and the form and the script both call it.
 */

/**
 * Slugs a customer may not register.
 *
 * `clinicti` is the one that matters: it is the vendor's own workspace, the only
 * clinic carrying the agency vocabulary, and `scripts/qa-vocabulary.ts` asserts
 * that no *other* clinic carries it. That assertion is worth nothing if a
 * customer can take the slug first. The rest are route prefixes — a clinic slug
 * is not what decides routing, but a workspace at `/c/api` reads as a bug report
 * waiting to happen.
 */
export const RESERVED_SLUGS = new Set([
  "clinicti",
  "admin",
  "api",
  "book",
  "sign",
  "sign-device",
  "inv",
  "invite",
  "login",
  "c",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.trim().toLowerCase());
}

type RecipeStep = {
  step_type: string;
  config?: Record<string, unknown>;
  children?: { yes?: RecipeStep[]; no?: RecipeStep[] };
};

/** Copies a recipe's step tree (including condition branches) into a clinic. */
async function copySteps(
  c: PoolClient,
  clinicId: string,
  automationId: string,
  steps: unknown[],
  parentId: string | null,
  branch: "yes" | "no" | null
) {
  let sort = 0;
  for (const raw of steps as RecipeStep[]) {
    const r = await c.query(
      `insert into automation_steps (clinic_id, automation_id, parent_step_id, branch, sort, step_type, config)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [clinicId, automationId, parentId, branch, sort++, raw.step_type, JSON.stringify(raw.config ?? {})]
    );
    const stepId = r.rows[0].id as string;
    if (raw.children?.yes?.length) {
      await copySteps(c, clinicId, automationId, raw.children.yes, stepId, "yes");
    }
    if (raw.children?.no?.length) {
      await copySteps(c, clinicId, automationId, raw.children.no, stepId, "no");
    }
  }
}

/**
 * Gives a clinic the recipe library for its field: the general one everybody
 * gets, plus its own specialty's pack.
 *
 * Additive and re-runnable. A recipe the clinic already holds a copy of is
 * skipped rather than duplicated, which is what makes this safe to call again
 * when the agency corrects a specialty that was chosen wrongly — the clinic's
 * own edits to the copies it already has are never touched.
 *
 * Returns how many were newly installed, because "nothing happened" and "eleven
 * flows appeared in their workspace" should not look the same to whoever
 * pressed the button.
 */
export async function installRecipes(
  c: PoolClient,
  clinicId: string,
  specialty: Specialty
): Promise<number> {
  const recipes = await c.query(
    `select * from recipe_templates
      where active and specialty in ('general', $1)
        and key not in (select recipe_key from automations where clinic_id = $2 and recipe_key is not null)
      order by sort`,
    [specialty, clinicId]
  );
  for (const r of recipes.rows) {
    const a = await c.query(
      `insert into automations (clinic_id, name, description, trigger_type, trigger_config, active, recipe_key, recipe_specialty)
       values ($1, $2, $3, $4, $5, $7, $6, $8) returning id`,
      [
        clinicId,
        r.name_ar || r.name,
        r.description,
        r.trigger_type,
        JSON.stringify(r.trigger_config ?? {}),
        r.key,
        RECIPES_ON_BY_DEFAULT.has(r.key as string),
        r.specialty ?? "general",
      ]
    );
    await copySteps(c, clinicId, a.rows[0].id, Array.isArray(r.steps) ? r.steps : [], null, null);
  }
  return recipes.rowCount ?? 0;
}

export type ProvisionInput = {
  name: string;
  nameAr?: string | null;
  slug: string;
  phoneE164?: string | null;
  plan?: string;
  planPrice?: number;
  features?: FeatureMap;
  specialty: Specialty;
  ownerEmail: string;
  ownerName: string;
  /**
   * Screen wording. Only Clinicti's own workspace passes `agency`; everything
   * else takes the column default and never thinks about it.
   */
  vocabulary?: "medical" | "agency";
  defaultLocale?: "ar" | "en";
  currency?: string;
  timezone?: string;
};

export type ProvisionResult = {
  clinicId: string;
  slug: string;
  ownerId: string;
  /** False when the email already had an account — they have a password already. */
  ownerIsNew: boolean;
};

/**
 * Creates a clinic and everything it needs to work on its first day.
 *
 * Must run inside a transaction the caller owns, so a failure anywhere leaves no
 * half-built workspace behind. Throws `slug_taken` rather than returning it,
 * because the caller's transaction has to roll back either way.
 */
export async function provisionClinic(
  c: PoolClient,
  input: ProvisionInput
): Promise<ProvisionResult> {
  const dup = await c.query("select 1 from clinics where slug = $1", [input.slug]);
  if (dup.rowCount) throw new Error("slug_taken");

  const features = input.features ?? allFeatures();

  const clinic = await c.query(
    `insert into clinics (name, name_ar, slug, phone_e164, plan, plan_price, features, specialty,
                          vocabulary, default_locale, currency, timezone)
     values ($1, $2, $3, $4, $5, $6, $7, $8,
             coalesce($9, 'medical'),
             coalesce($10, 'ar'),
             coalesce($11, 'JOD'),
             coalesce($12, 'Asia/Amman'))
     returning id, slug`,
    // Features written out in full rather than as "only the exceptions", so the
    // row records what was actually sold on the day it was sold. A feature added
    // to the product next year then arrives switched *on* for this clinic — the
    // same rule every existing clinic gets — and the agency turns it off
    // deliberately if it is not part of the deal.
    [
      input.name,
      input.nameAr || null,
      input.slug,
      input.phoneE164 ?? null,
      input.plan ?? "standard",
      input.planPrice ?? 0,
      JSON.stringify(toFeatureSetting(features)),
      input.specialty,
      input.vocabulary ?? null,
      input.defaultLocale ?? null,
      input.currency ?? null,
      input.timezone ?? null,
    ]
  );
  const clinicId = clinic.rows[0].id as string;

  /*
    Owner account: reuse an existing user with this email, otherwise create one
    with no password at all.

    The agency used to type a password here and pass it to the owner, which meant
    we chose it, we knew it, and it travelled to them over whatever channel was
    handy. Staff invitations already worked the right way — an emailed link, a
    password only the invitee ever sees — and there was no reason the owner of the
    clinic should be the one person onboarded worse than their own receptionist.

    password_hash stays null until they accept, so the account cannot be signed
    into before then.
  */
  let ownerId: string;
  let ownerIsNew = false;
  const existing = await c.query("select id from users where lower(email) = $1", [
    input.ownerEmail.toLowerCase(),
  ]);
  if (existing.rowCount) {
    ownerId = existing.rows[0].id as string;
  } else {
    const u = await c.query(`insert into users (email, full_name) values ($1, $2) returning id`, [
      input.ownerEmail,
      input.ownerName,
    ]);
    ownerId = u.rows[0].id as string;
    ownerIsNew = true;
  }
  // The first member owns the clinic and always has full access. Their job title
  // is a guess the clinic corrects in staff settings; ownership is not.
  await c.query(
    `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
     values ($1, $2, 'other', true, '{"level":"full"}')`,
    [clinicId, ownerId]
  );

  // Baseline per-clinic rows
  await c.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);
  await c.query(`insert into ai_agents (clinic_id, agent_name) values ($1, $2)`, [
    clinicId,
    input.nameAr || input.name,
  ]);
  await c.query(`insert into booking_links (clinic_id, slug, name) values ($1, $2, 'Default')`, [
    clinicId,
    input.slug,
  ]);

  // Copy agency defaults: automation recipes (disabled) and knowledge structure
  await installRecipes(c, clinicId, input.specialty);
  // The doctor and staff alerts this clinic will be able to edit from its own
  // automations page. Seeded with exactly what the worker used to do.
  await seedStaffAlerts(c, clinicId);
  const kts = await c.query("select * from knowledge_templates order by sort");
  for (const k of kts.rows) {
    await c.query(
      `insert into ai_knowledge_items (clinic_id, category, title, content, sort)
       values ($1, $2, $3, $4, $5)`,
      [clinicId, k.category, k.title, k.content, k.sort]
    );
  }

  // Signing: the starting field definitions and signer roles, then a copy of the
  // agency's consent-form library. Copies, not references — the clinic owns its
  // forms from the first day and can rewrite any of them.
  await c.query(`select seed_esign_defaults($1)`, [clinicId]);
  // The two note categories every clinic starts with. Renameable and reorderable
  // from the patient file; never deletable, because the notes written under them
  // point here.
  await c.query(`select seed_note_categories($1)`, [clinicId]);
  const docTemplates = await c.query(
    "select * from document_template_library where active order by sort"
  );
  for (const lt of docTemplates.rows) {
    await c.query(
      `insert into document_templates
         (clinic_id, name, name_ar, category, body, body_ar, language, signer_config,
          fields_schema, library_key, created_by)
       values ($1, $2, $3, $4, $5, $6, 'both', $7, $8, $9, $10)`,
      [
        clinicId,
        lt.name,
        lt.name_ar || null,
        lt.category,
        lt.body,
        lt.body_ar,
        /*
          Re-serialised, not passed through. pg hands jsonb back as parsed
          JavaScript, and node-pg encodes a JS *array* as a Postgres array
          literal — so `fields_schema: []` went out as `{}` and the insert failed
          with "invalid input syntax for type json", taking the whole
          clinic-creation transaction with it.
        */
        JSON.stringify(lt.signer_config ?? {}),
        JSON.stringify(lt.fields_schema ?? []),
        lt.key,
        ownerId,
      ]
    );
  }

  return { clinicId, slug: clinic.rows[0].slug as string, ownerId, ownerIsNew };
}
