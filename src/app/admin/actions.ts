"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin, requireAdminCap, createSession, setSessionCookie } from "@/lib/auth";
import { createAuthToken } from "@/lib/invites";
import { sendEmail, renderEmail } from "@/lib/email";
import { appUrl } from "@/lib/urls";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { sanitizeHtml } from "@/lib/esign/render";
import { RECIPES_ON_BY_DEFAULT } from "@/lib/esign/constants";
import { deleteClinicFiles } from "@/lib/storage";
import { internalSecret } from "@/lib/internal-secret";
import { FEATURES, toFeatureSetting, type Feature, type FeatureMap } from "@/lib/features";
import { RESTORE_WINDOW_DAYS } from "@/lib/clinic-lifecycle";
import { SPECIALTIES, asSpecialty, type Specialty } from "@/lib/specialties";
import { seedStaffAlerts } from "@/lib/staff-alerts";
import { z } from "zod";

/**
 * The licence, as it arrives from the form.
 *
 * A comma-separated list of the modules that are *on*, because that is what an
 * HTML form gives you for free and because the alternative — a checkbox per
 * feature, absent when unticked — makes "everything off" indistinguishable from
 * "an old client that did not send the field". An explicit list of one is still
 * a list; a missing field is rejected below.
 */
const featureListSchema = z
  .string()
  .default("")
  .transform((raw): FeatureMap => {
    const on = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    return Object.fromEntries(FEATURES.map((f) => [f, on.has(f)])) as FeatureMap;
  });

const createClinicSchema = z.object({
  name: z.string().min(2).max(80),
  nameAr: z.string().max(80).optional().default(""),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  phone: z.string().optional().default(""),
  plan: z.string().default("standard"),
  planPrice: z.coerce.number().min(0).default(0),
  ownerName: z.string().min(2).max(80),
  ownerEmail: z.string().email(),
  features: featureListSchema,
  // Unknown values fall back to 'general' rather than rejecting the form: a
  // clinic is not worth failing to create over which pack of disabled recipes
  // it starts with, and the agency can change it afterwards.
  specialty: z.enum(SPECIALTIES).catch("general" as Specialty),
});

export type CreateClinicResult = { error?: string; fieldErrors?: Record<string, string> } | null;

type RecipeStep = {
  step_type: string;
  config?: Record<string, unknown>;
  children?: { yes?: RecipeStep[]; no?: RecipeStep[] };
};

/** Copies a recipe's step tree (including condition branches) into a clinic. */
async function copySteps(
  c: import("pg").PoolClient,
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
async function installRecipes(
  c: import("pg").PoolClient,
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

/**
 * Changes a clinic's field and hands it the recipes that come with it.
 *
 * Nothing is removed. A clinic that was set up as general practice and is
 * really a dental clinic has spent months editing the flows it does have, and
 * deleting them to "clean up" would throw that away to fix a dropdown.
 */
export async function setClinicSpecialtyAction(
  slug: string,
  specialty: string
): Promise<{ installed?: number; error?: string }> {
  const s = await requireAdminCap("clinics.edit");
  const chosen = asSpecialty(specialty);
  return withSystem(async (c) => {
    const clinic = await c.query(`select id from clinics where slug = $1`, [slug]);
    if (!clinic.rowCount) return { error: "not_found" };
    const clinicId = clinic.rows[0].id as string;
    await c.query(`update clinics set specialty = $2 where id = $1`, [clinicId, chosen]);
    const installed = await installRecipes(c, clinicId, chosen);
    await audit(c, {
      clinicId,
      userId: s.user.id,
      action: "admin.clinic.specialty",
      entity: "clinic",
      entityId: clinicId,
      detail: { specialty: chosen, installed },
    });
    revalidatePath(`/admin/clinics/${slug}`);
    return { installed };
  });
}

export async function createClinicAction(
  _prev: CreateClinicResult,
  formData: FormData
): Promise<CreateClinicResult> {
  const s = await requireAdminCap("clinics.create");
  const parsed = createClinicSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors };
  }
  const d = parsed.data;
  const phone = d.phone ? normalizePhone(d.phone) : null;

  let slug = "";
  // Set inside the transaction, read after it: only a brand-new account needs an
  // invitation. Somebody who already runs another clinic has a password already.
  let ownerIsNew = false;
  let ownerId = "";
  let clinicId = "";
  try {
    slug = await withSystem(async (c) => {
      const dup = await c.query("select 1 from clinics where slug = $1", [d.slug]);
      if (dup.rowCount) throw new Error("slug_taken");

      const clinic = await c.query(
        `insert into clinics (name, name_ar, slug, phone_e164, plan, plan_price, features, specialty)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, slug`,
        // Written out in full rather than as "only the exceptions", so the row
        // records what was actually sold on the day it was sold. A feature added
        // to the product next year then arrives switched *on* for this clinic —
        // the same rule every existing clinic gets — and the agency turns it off
        // deliberately if it is not part of the deal.
        [
          d.name, d.nameAr || null, d.slug, phone, d.plan, d.planPrice,
          JSON.stringify(toFeatureSetting(d.features)), d.specialty,
        ]
      );
      clinicId = clinic.rows[0].id as string;

      /*
        Owner account: reuse an existing user with this email, otherwise create
        one with no password at all.

        The agency used to type a password here and pass it to the owner, which
        meant we chose it, we knew it, and it travelled to them over whatever
        channel was handy. Staff invitations already worked the right way — an
        emailed link, a password only the invitee ever sees — and there was no
        reason the owner of the clinic should be the one person onboarded worse
        than their own receptionist.

        password_hash stays null until they accept, so the account cannot be
        signed into before then.
      */
      const existing = await c.query("select id from users where lower(email) = $1", [
        d.ownerEmail.toLowerCase(),
      ]);
      if (existing.rowCount) {
        ownerId = existing.rows[0].id;
      } else {
        const u = await c.query(
          `insert into users (email, full_name) values ($1, $2) returning id`,
          [d.ownerEmail, d.ownerName]
        );
        ownerId = u.rows[0].id;
        ownerIsNew = true;
      }
      // The first member owns the clinic and always has full access. Their job
      // title is a guess the clinic corrects in staff settings; ownership is not.
      await c.query(
        `insert into clinic_members (clinic_id, user_id, role, is_owner, permissions)
         values ($1, $2, 'other', true, '{"level":"full"}')`,
        [clinicId, ownerId]
      );

      // Baseline per-clinic rows
      await c.query(`insert into whatsapp_sessions (clinic_id) values ($1)`, [clinicId]);
      await c.query(`insert into ai_agents (clinic_id, agent_name) values ($1, $2)`, [
        clinicId,
        d.nameAr || d.name,
      ]);
      await c.query(
        `insert into booking_links (clinic_id, slug, name) values ($1, $2, 'Default')`,
        [clinicId, d.slug]
      );

      // Copy agency defaults: automation recipes (disabled) and knowledge structure
      await installRecipes(c, clinicId, d.specialty);
      // The doctor and staff alerts this clinic will be able to edit from its
      // own automations page. Seeded with exactly what the worker used to do.
      await seedStaffAlerts(c, clinicId);
      const kts = await c.query("select * from knowledge_templates order by sort");
      for (const k of kts.rows) {
        await c.query(
          `insert into ai_knowledge_items (clinic_id, category, title, content, sort)
           values ($1, $2, $3, $4, $5)`,
          [clinicId, k.category, k.title, k.content, k.sort]
        );
      }

      // Signing: the starting field definitions and signer roles, then a copy of
      // the agency's consent-form library. Copies, not references — the clinic
      // owns its forms from the first day and can rewrite any of them.
      await c.query(`select seed_esign_defaults($1)`, [clinicId]);
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
              literal — so `fields_schema: []` went out as `{}` and the insert
              failed with "invalid input syntax for type json", taking the whole
              clinic-creation transaction with it.
            */
            JSON.stringify(lt.signer_config ?? {}),
            JSON.stringify(lt.fields_schema ?? []),
            lt.key,
            ownerId,
          ]
        );
      }

      await audit(c, {
        clinicId,
        userId: s.user.id,
        action: "admin.clinic.create",
        entity: "clinic",
        entityId: clinicId,
        detail: { name: d.name, slug: d.slug, features: toFeatureSetting(d.features) },
      });
      return clinic.rows[0].slug as string;
    });
  } catch (e) {
    if ((e as Error).message === "slug_taken") return { fieldErrors: { slug: "taken" } };
    console.error("createClinic failed", e);
    return { error: "generic" };
  }

  /*
    Outside the transaction on purpose. Sending mail is a network call to a third
    party that can hang for its full fifteen-second timeout, and holding a
    Postgres transaction open across it would pin a connection for that whole
    time. The clinic exists either way; a failed send is recoverable from the
    clinic page, an aborted creation is not.
  */
  if (ownerIsNew) {
    await sendOwnerInvite(clinicId, ownerId, d.ownerEmail, d.ownerName, s.user.id).catch((e) =>
      console.error("[owner invite]", (e as Error).message)
    );
  }

  revalidatePath("/admin");
  redirect(`/admin/clinics/${slug}`);
}

/**
 * Issues the owner's invitation and mails it.
 *
 * Shared by clinic creation and the resend button, so the two cannot drift into
 * sending different links or different wording.
 *
 * Returns the URL whatever happens. When Resend is not configured `sendEmail`
 * reports `skipped` rather than throwing, and the caller shows the link so the
 * agency can pass it on — onboarding is never blocked on a mail provider.
 */
async function sendOwnerInvite(
  clinicId: string,
  ownerId: string,
  email: string,
  name: string,
  createdBy: string
): Promise<{ url: string; emailed: boolean }> {
  const raw = await withSystem((c) =>
    createAuthToken(c, { userId: ownerId, clinicId, purpose: "invite", createdBy })
  );
  const url = `${appUrl()}/invite/${raw}`;
  const clinic = await withSystem(async (c) => {
    const r = await c.query(
      `select coalesce(nullif(name_ar, ''), name) as name, default_locale from clinics where id = $1`,
      [clinicId]
    );
    return {
      name: (r.rows[0]?.name as string) ?? "",
      locale: r.rows[0]?.default_locale === "en" ? ("en" as const) : ("ar" as const),
    };
  });
  const sent = await sendEmail({
    to: email,
    ...renderEmail({ type: "invitation", locale: clinic.locale, name, clinic: clinic.name, url }),
  });
  if (!sent.ok && !sent.skipped) console.error("[owner invite email]", sent.error);
  return { url, emailed: sent.ok };
}

/**
 * Re-issues the owner's invitation, invalidating any previous link.
 *
 * The counterpart to a send that silently failed — a bounced address, a mail
 * provider that was not configured yet, an owner who let the seven days lapse.
 * Without this the only remedy was recreating the clinic.
 */
export async function resendOwnerInviteAction(
  clinicId: string
): Promise<{ error?: string; url?: string; emailed?: boolean }> {
  const s = await requireAdminCap("clinics.edit");
  const owner = await withSystem(async (c) => {
    const r = await c.query(
      `select u.id, u.email, u.full_name, u.password_hash
         from clinic_members cm join users u on u.id = cm.user_id
        where cm.clinic_id = $1 and cm.is_owner
        order by cm.created_at limit 1`,
      [clinicId]
    );
    return r.rows[0] as
      | { id: string; email: string; full_name: string; password_hash: string | null }
      | undefined;
  });
  if (!owner) return { error: "no_owner" };
  // An owner who has already chosen a password does not need an invitation, and
  // issuing one would be a password-reset link nobody asked for.
  if (owner.password_hash) return { error: "already_active" };

  const { url, emailed } = await sendOwnerInvite(
    clinicId,
    owner.id,
    owner.email,
    owner.full_name,
    s.user.id
  );
  revalidatePath("/admin");
  /*
    The link comes back whether or not the mail was accepted, which differs from
    the staff invitation on purpose. Only a super admin can reach this, and they
    can impersonate the owner regardless, so it discloses nothing they did not
    already have — while an owner who never received the email is a support call
    that otherwise has no answer. In practice the agency sends it on WhatsApp.
  */
  return { emailed, url };
}

export async function updateSubscriptionAction(
  clinicId: string,
  data: { status?: string; plan?: string; planPrice?: number }
) {
  const s = await requireAdminCap("clinics.edit");
  const status = data.status;
  if (status && !["trial", "active", "past_due", "suspended"].includes(status)) return;
  await withSystem(async (c) => {
    await c.query(
      `update clinics set
         subscription_status = coalesce($2, subscription_status),
         plan = coalesce($3, plan),
         plan_price = coalesce($4, plan_price)
       where id = $1`,
      [clinicId, status ?? null, data.plan ?? null, data.planPrice ?? null]
    );
    await audit(c, {
      clinicId,
      userId: s.user.id,
      action: "admin.subscription.update",
      entity: "clinic",
      entityId: clinicId,
      detail: data as Record<string, unknown>,
    });
  });
  revalidatePath("/admin");
}

/* -------------------------------------------------------- clinic licensing */

/**
 * Changes which modules a clinic has.
 *
 * Nothing is deleted when a module is switched off — the automations, the
 * campaigns and the documents stay exactly where they are, and reappear intact
 * if it is switched back on. This is a licence, not an uninstall: a clinic that
 * lapses for a month and renews should find its work waiting for it, and an
 * agency that had to warn "this will erase your automations" would never dare
 * use the switch at all.
 *
 * It takes effect on the clinic's next page load, because capabilities are
 * resolved per request from the session query rather than cached on the
 * session row.
 */
export async function updateClinicFeaturesAction(
  clinicId: string,
  features: Record<string, boolean>
): Promise<{ error?: string }> {
  const s = await requireAdminCap("clinics.features");

  // Whatever the client sent, only known keys are stored and every one of them
  // is written explicitly — a partial map would leave old keys behind and make
  // the stored row disagree with the screen that wrote it.
  const clean = Object.fromEntries(
    FEATURES.map((f) => [f, features[f] === true])
  ) as Record<Feature, boolean>;

  await withSystem(async (c) => {
    const r = await c.query(
      `update clinics set features = $2, updated_at = now()
        where id = $1 and deleted_at is null
        returning slug`,
      [clinicId, JSON.stringify(clean)]
    );
    if (!r.rowCount) return;
    await audit(c, {
      clinicId,
      userId: s.user.id,
      action: "admin.clinic.features",
      entity: "clinic",
      entityId: clinicId,
      detail: clean,
    });
  });

  revalidatePath("/admin");
  return {};
}

/* --------------------------------------------------------- clinic deletion */


const WORKER_URL = process.env.WORKER_URL || "http://localhost:4020";
const INTERNAL_SECRET = () => internalSecret();

/**
 * Drops the clinic's WhatsApp connection.
 *
 * Best effort on purpose, and never allowed to fail the caller: a worker that
 * is down must not be able to block a deletion, and the session cannot outlive
 * it in any case — `desired` is cleared in the same transaction, and the
 * worker's resume loop skips deleted clinics. This is here so the phone stops
 * receiving messages within seconds rather than at the next worker restart.
 */
async function disconnectWhatsApp(clinicId: string): Promise<void> {
  await fetch(`${WORKER_URL}/sessions/${clinicId}/disconnect`, {
    method: "POST",
    headers: { "x-internal-secret": INTERNAL_SECRET() },
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

/**
 * Deletes a clinic — reversibly, for the length of the restore window.
 *
 * What this does *not* do is `delete from clinics`. Every foreign key into that
 * table cascades, all forty-nine of them, so the real delete takes the patient
 * files, the appointment history, the signed consent forms and the invoices
 * with it in one statement and leaves nothing to apologise with. That is the
 * right outcome for a clinic that has genuinely gone, and an unrecoverable
 * accident for a mis-click, and until now they were the same keystroke.
 *
 * So the clinic goes dark instead: nobody can sign in (see `requireClinic`),
 * WhatsApp disconnects, queued outbound is dropped, and it moves to the deleted
 * list with a countdown. The worker performs the irreversible part once the
 * window closes.
 *
 * The typed slug is not decoration. It is the difference between "I clicked the
 * wrong row" and "I meant this clinic", and it is checked on the server because
 * a confirmation the client can skip is not a confirmation.
 */
export async function deleteClinicAction(
  clinicId: string,
  confirmSlug: string
): Promise<{ error?: string }> {
  const s = await requireAdminCap("clinics.delete");

  const result = await withSystem(async (c) => {
    const r = await c.query(
      `select slug, name, deleted_at from clinics where id = $1`,
      [clinicId]
    );
    const clinic = r.rows[0] as { slug: string; name: string; deleted_at: Date | null } | undefined;
    if (!clinic) return { error: "not_found" as const };
    if (clinic.deleted_at) return { error: "already_deleted" as const };
    if (clinic.slug !== confirmSlug.trim()) return { error: "slug_mismatch" as const };

    await c.query(
      `update clinics set deleted_at = now(), deleted_by = $2, updated_at = now() where id = $1`,
      [clinicId, s.user.id]
    );

    /*
      Sessions are deliberately left alone.

      The instinct is to sign everybody out, and it is wrong here. A session is
      per *user*, not per clinic, so deleting them would also sign out a
      receptionist who works at a second clinic that has nothing to do with
      this — for no gain, because the flag above already closes the door: every
      screen under /c/[slug] goes through `requireClinic`, every API route
      through `apiClinic`, and both now refuse a deleted clinic on the next
      request. There is no window in which the old cookie is worth anything.
    */
    await c.query(`update whatsapp_sessions set desired = false where clinic_id = $1`, [clinicId]);
    // Anything the worker has not sent yet never should be — a reminder landing
    // on a patient's phone the day after their clinic closed is worse than none.
    await c.query(
      `update messages set status = 'cancelled'
        where clinic_id = $1 and status = 'queued'`,
      [clinicId]
    );
    await c.query(`delete from jobs where clinic_id = $1 and status = 'pending'`, [clinicId]);

    /*
      Audited with clinic_id null. `audit_log.clinic_id` cascades like everything
      else, so filing this against the clinic would mean the record of the
      deletion is destroyed by the deletion it records. The slug and name go in
      `detail` instead, where they survive the purge.
    */
    await audit(c, {
      userId: s.user.id,
      action: "admin.clinic.delete",
      entity: "clinic",
      entityId: clinicId,
      detail: { slug: clinic.slug, name: clinic.name, restoreWindowDays: RESTORE_WINDOW_DAYS },
    });
    return { slug: clinic.slug };
  });

  if ("error" in result) return result;

  await disconnectWhatsApp(clinicId);
  revalidatePath("/admin");
  return {};
}

/** Puts a deleted clinic back. Everything is still there; only the flag moves. */
export async function restoreClinicAction(clinicId: string): Promise<{ error?: string }> {
  const s = await requireAdminCap("clinics.delete");

  const ok = await withSystem(async (c) => {
    const r = await c.query(
      `update clinics set deleted_at = null, deleted_by = null, updated_at = now()
        where id = $1 and deleted_at is not null
        returning slug, name`,
      [clinicId]
    );
    if (!r.rowCount) return false;
    await audit(c, {
      clinicId,
      userId: s.user.id,
      action: "admin.clinic.restore",
      entity: "clinic",
      entityId: clinicId,
      detail: { slug: r.rows[0].slug, name: r.rows[0].name },
    });
    return true;
  });
  if (!ok) return { error: "not_found" };

  /*
    WhatsApp is deliberately left disconnected. Reconnecting a Baileys session
    unattended means a clinic's number silently starts sending again — possibly
    weeks of queued automation logic later — with nobody at the clinic aware it
    came back. The owner reconnects it from their own settings, which is a
    scan they will be present for.
  */
  revalidatePath("/admin");
  return {};
}

/**
 * The irreversible one.
 *
 * Normally the worker does this on the window expiring; this is the manual
 * override for a clinic that was never real — a demo, a typo, a test tenant —
 * where waiting sixty days to tidy up is silly. Same guard as the delete: the
 * clinic must already be deleted, and the slug must be typed again. Deleting
 * something twice on purpose is about as much friction as this deserves.
 */
export async function purgeClinicAction(
  clinicId: string,
  confirmSlug: string
): Promise<{ error?: string }> {
  const s = await requireAdminCap("clinics.delete");

  const clinic = await withSystem(async (c) => {
    const r = await c.query(`select slug, name, deleted_at from clinics where id = $1`, [clinicId]);
    return r.rows[0] as { slug: string; name: string; deleted_at: Date | null } | undefined;
  });
  if (!clinic) return { error: "not_found" };
  // Never a one-step destruction. Deleting first is what gives anybody the
  // chance to notice, and skipping straight here would put the cascade back
  // behind a single button.
  if (!clinic.deleted_at) return { error: "not_deleted" };
  if (clinic.slug !== confirmSlug.trim()) return { error: "slug_mismatch" };

  await purgeClinic(clinicId, clinic.slug, clinic.name, s.user.id);
  revalidatePath("/admin");
  return {};
}

/**
 * Destroys a clinic and everything filed under it.
 *
 * Files first, row second, and the order matters: the row is the only thing
 * that says this clinic ever existed, so losing it before the bucket is cleared
 * would leave a folder of patient scans nobody can attribute or find. Doing it
 * the other way round costs at worst a retry — the delete is idempotent, and a
 * clinic whose files went but whose row survived is still in the deleted list,
 * still due to be purged.
 */
async function purgeClinic(
  clinicId: string,
  slug: string,
  name: string,
  byUserId: string | null
): Promise<void> {
  const files = await deleteClinicFiles(clinicId).catch((e) => {
    console.error("[purge] storage", (e as Error).message);
    return -1;
  });

  await withSystem(async (c) => {
    // One statement, forty-nine cascades.
    await c.query(`delete from clinics where id = $1`, [clinicId]);
    await audit(c, {
      userId: byUserId,
      action: "admin.clinic.purge",
      entity: "clinic",
      entityId: clinicId,
      detail: { slug, name, filesDeleted: files },
    });
  });
}

/** Ends support mode: drops the impersonation session and issues a clean admin one. */
export async function exitImpersonationAction() {
  const s = await requireSuperAdmin();
  await withSystem(async (c) => {
    if (s.impersonatedBy) {
      await audit(c, {
        userId: s.user.id,
        impersonatedBy: s.impersonatedBy,
        action: "admin.impersonate.end",
      });
    }
    await c.query(`delete from sessions where id = $1`, [s.sessionId]);
  });
  const token = await createSession(s.user.id);
  await setSessionCookie(token);
  redirect("/admin");
}

/** Support-mode entry: a new audited session that keeps the admin identity attached. */
export async function impersonateAction(clinicSlug: string) {
  const s = await requireAdminCap("clinics.impersonate");
  await withSystem(async (c) => {
    const r = await c.query("select id from clinics where slug = $1 and deleted_at is null", [
      clinicSlug,
    ]);
    if (!r.rowCount) throw new Error("clinic not found");
    await audit(c, {
      clinicId: r.rows[0].id,
      userId: s.user.id,
      impersonatedBy: s.user.id,
      action: "admin.impersonate.start",
      entity: "clinic",
      entityId: r.rows[0].id,
    });
  });
  const token = await createSession(s.user.id, { impersonatedBy: s.user.id });
  await setSessionCookie(token);
  redirect(`/c/${clinicSlug}`);
}

/* ------------------------------------------------- agency document library */

const librarySchema = z.object({
  id: z.string().uuid().optional(),
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,58}$/),
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).default(""),
  category: z.enum(["consent", "treatment_plan", "financial", "privacy", "other"]),
  body: z.string().max(80_000).default(""),
  bodyAr: z.string().max(80_000).default(""),
  sort: z.coerce.number().int().min(0).max(9999).default(100),
  active: z.boolean().default(true),
});

/**
 * The starter form every new clinic is seeded with.
 *
 * Editing one never reaches a clinic that already holds a copy — copies are made
 * once, at clinic creation, and are the clinic's own from that moment. That is
 * the point: a clinic must be able to rewrite its consent wording without the
 * agency overwriting it later.
 */
export async function saveLibraryTemplateAction(
  input: unknown
): Promise<{ error?: string; id?: string }> {
  const s = await requireAdminCap("documents");
  const parsed = librarySchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const d = parsed.data;
  const body = sanitizeHtml(d.body);
  const bodyAr = sanitizeHtml(d.bodyAr);

  const id = await withSystem(async (c) => {
    if (d.id) {
      await c.query(
        `update document_template_library
            set name = $2, name_ar = $3, category = $4, body = $5, body_ar = $6,
                sort = $7, active = $8
          where id = $1`,
        [d.id, d.name, d.nameAr, d.category, body, bodyAr, d.sort, d.active]
      );
      return d.id;
    }
    const r = await c.query(
      `insert into document_template_library (key, name, name_ar, category, body, body_ar, sort, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (key) do nothing
       returning id`,
      [d.key, d.name, d.nameAr, d.category, body, bodyAr, d.sort, d.active]
    );
    return (r.rows[0]?.id as string) ?? null;
  });
  if (!id) return { error: "duplicate" };

  await withSystem((c) =>
    audit(c, {
      userId: s.user.id,
      action: d.id ? "admin.doc_library.update" : "admin.doc_library.create",
      entity: "document_template_library",
      entityId: id,
      detail: { key: d.key },
    })
  );
  revalidatePath("/admin/documents");
  return { id };
}

export async function deleteLibraryTemplateAction(id: string): Promise<void> {
  const s = await requireAdminCap("documents");
  await withSystem(async (c) => {
    await c.query(`delete from document_template_library where id = $1`, [id]);
    await audit(c, {
      userId: s.user.id,
      action: "admin.doc_library.delete",
      entity: "document_template_library",
      entityId: id,
    });
  });
  revalidatePath("/admin/documents");
}
