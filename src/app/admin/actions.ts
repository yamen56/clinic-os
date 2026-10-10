"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { headers } from "next/headers";
import {
  requireSuperAdmin,
  requireAdminCap,
  insertSession,
  setSessionCookie,
} from "@/lib/auth";
import { actionIp } from "@/lib/auth-throttle";
import { SUPPORT_VISIT_HOURS, cleanSupportReason } from "@/lib/support-visits";
import { createAuthToken } from "@/lib/invites";
import { sendEmail, renderEmail } from "@/lib/email";
import { appUrl } from "@/lib/urls";
import { withSystem } from "@/lib/db";
import { audit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { sanitizeHtml } from "@/lib/esign/render";
import { deleteClinicFiles } from "@/lib/storage";
import { internalSecret } from "@/lib/internal-secret";
import { FEATURES, toFeatureSetting, type Feature, type FeatureMap } from "@/lib/features";
import { RESTORE_WINDOW_DAYS } from "@/lib/clinic-lifecycle";
import { SPECIALTIES, asSpecialty, clinicSpecialties, isSpecialty, type Specialty } from "@/lib/specialties";
import { provisionClinic, installRecipes, isReservedSlug } from "@/lib/clinic-provision";
import { SPECIALTY_MODULES, modulesFor } from "@/lib/specialty-profile";
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
  // A medical centre's other departments, as a comma list like `features`.
  // Unknown values are dropped, for the same reason as the specialty above.
  departments: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").map((v) => v.trim()).filter(isSpecialty)),
});

export type CreateClinicResult = { error?: string; fieldErrors?: Record<string, string> } | null;


/**
 * Changes a clinic's field and hands it the recipes that come with it.
 *
 * Nothing is removed. A clinic that was set up as general practice and is
 * really a dental clinic has spent months editing the flows it does have, and
 * deleting them to "clean up" would throw that away to fix a dropdown.
 */
export async function setClinicSpecialtyAction(
  slug: string,
  specialty: string,
  departments: string[] = []
): Promise<{ installed?: number; error?: string }> {
  const s = await requireAdminCap("clinics.edit");
  const chosen = asSpecialty(specialty);
  // Everything it practises — what decides the charts on its patient files.
  const practises = clinicSpecialties(chosen, departments);
  return withSystem(async (c) => {
    const clinic = await c.query(`select id, specialty, specialties, features from clinics where slug = $1`, [slug]);
    if (!clinic.rowCount) return { error: "not_found" };
    const clinicId = clinic.rows[0].id as string;
    /*
      The modules a specialty brings follow it: adding Dental switches the
      dental chart on, and taking away the last field that needed a module
      switches it off. A module no specialty change touched keeps whatever the
      agency set by hand.
    */
    const before = modulesFor(clinicSpecialties(clinic.rows[0].specialty, clinic.rows[0].specialties ?? []));
    const after = modulesFor(practises.length ? practises : [chosen]);
    const features = { ...(clinic.rows[0].features ?? {}) } as Record<string, boolean>;
    const switched: Record<string, boolean> = {};
    for (const m of SPECIALTY_MODULES) {
      if (after.includes(m) && !before.includes(m)) switched[m] = features[m] = true;
      else if (before.includes(m) && !after.includes(m)) switched[m] = features[m] = false;
    }
    await c.query(`update clinics set specialty = $2, specialties = $3, features = $4::jsonb where id = $1`, [clinicId, chosen, practises, JSON.stringify(features)]);
    let installed = 0;
    for (const sp of practises.length ? practises : [chosen]) installed += await installRecipes(c, clinicId, sp);
    await audit(c, {
      clinicId,
      userId: s.user.id,
      action: "admin.clinic.specialty",
      entity: "clinic",
      entityId: clinicId,
      detail: { specialty: chosen, specialties: practises, installed, modules: switched },
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
  let ownerId = "";
  let clinicId = "";
  /*
    Reserved before uniqueness is even checked. `clinicti` is the vendor's own
    workspace and the only clinic carrying the agency vocabulary; a customer who
    registered that slug would take the name and quietly break the assertion in
    qa-vocabulary.ts that no other clinic has been switched.
  */
  if (isReservedSlug(d.slug)) return { fieldErrors: { slug: "reserved" } };

  try {
    slug = await withSystem(async (c) => {
      const p = await provisionClinic(c, {
        name: d.name,
        nameAr: d.nameAr,
        slug: d.slug,
        phoneE164: phone,
        plan: d.plan,
        planPrice: d.planPrice,
        features: d.features,
        specialty: d.specialty,
        departments: d.departments,
        ownerEmail: d.ownerEmail,
        ownerName: d.ownerName,
      });
      clinicId = p.clinicId;
      ownerId = p.ownerId;

      await audit(c, {
        clinicId,
        userId: s.user.id,
        action: "admin.clinic.create",
        entity: "clinic",
        entityId: clinicId,
        detail: { name: d.name, slug: d.slug, features: toFeatureSetting(d.features) },
      });
      return p.slug;
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
  await notifyNewOwner(clinicId, ownerId, s.user.id).catch((e) =>
    console.error("[owner invite]", (e as Error).message)
  );

  revalidatePath("/admin");
  redirect(`/admin/clinics/${slug}`);
}

/**
 * Tells a new clinic's owner about it, whoever they are.
 *
 * This used to invite only an address Clinicti had never seen, on the
 * assumption that anyone already known "runs another clinic and has a
 * password". Neither half held: an owner invited to another clinic who had not
 * accepted yet got nothing and had no way in, and one who had accepted was made
 * owner of a workspace nobody told them about. Now an account without a password
 * gets this clinic's invitation, and one with a password is told it was added,
 * with a link to this clinic.
 */
async function notifyNewOwner(clinicId: string, ownerId: string, createdBy: string): Promise<void> {
  const owner = await withSystem(async (c) => {
    const r = await c.query(
      `select u.email, u.full_name, u.locale, u.password_hash is not null as has_password,
              cl.slug, coalesce(nullif(cl.name_ar, ''), cl.name) as clinic_name
         from users u, clinics cl
        where u.id = $1 and cl.id = $2`,
      [ownerId, clinicId]
    );
    return r.rows[0];
  });
  if (!owner) return;
  if (!owner.has_password) {
    await sendOwnerInvite(clinicId, ownerId, owner.email, owner.full_name, createdBy);
    return;
  }
  const sent = await sendEmail({
    to: owner.email,
    ...renderEmail({
      type: "added-to-clinic",
      locale: owner.locale === "en" ? "en" : "ar",
      name: owner.full_name,
      clinic: owner.clinic_name,
      url: `${appUrl()}/c/${owner.slug}`,
      email: owner.email,
    }),
  });
  if (!sent.ok && !sent.skipped) console.error("[owner added email]", sent.error);
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
  const was = await withSystem(async (c) => {
    // `old` is read under the row lock, so `was` is the status this save replaced.
    const r = await c.query(
      `update clinics cl set
         subscription_status = coalesce($2, cl.subscription_status),
         plan = coalesce($3, cl.plan),
         plan_price = coalesce($4, cl.plan_price)
       from (select subscription_status from clinics where id = $1 for update) old
       where cl.id = $1
       returning old.subscription_status as was`,
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
    return r.rows[0]?.was as string | undefined;
  });
  revalidatePath("/admin");

  /*
    Only on the change itself. The same modal saves the plan and the price, and
    re-saving a clinic that is already past due must not send the reminder again.
    `after` keeps the modal from waiting on the mail provider.
  */
  if ((status === "past_due" || status === "suspended") && was && was !== status) {
    after(() => emailOwnersAboutStatus(clinicId, status));
  }
}

/**
 * Tells a clinic's owners that its subscription is past due, or that it has
 * been suspended.
 *
 * Suspension is otherwise silent — the first anyone hears of it is a morning
 * where nobody can sign in — and "past due" is the only warning the platform
 * has, because suspending is a decision the agency makes by hand rather than a
 * date that arrives. Both say what actually stops (sign-in, the booking page)
 * and that nothing is deleted, and both are answered by replying, which lands
 * with the agency through EMAIL_REPLY_TO.
 *
 * Re-reads the status before sending, so a mistaken click put straight back
 * does not announce something that is no longer true.
 */
async function emailOwnersAboutStatus(
  clinicId: string,
  status: "past_due" | "suspended"
): Promise<void> {
  try {
    const owners = await withSystem(async (c) => {
      const r = await c.query(
        `select u.email, u.full_name, u.locale, cl.slug,
                coalesce(nullif(cl.name_ar, ''), cl.name) as clinic_name
           from clinic_members m
           join users u on u.id = m.user_id
           join clinics cl on cl.id = m.clinic_id
          where m.clinic_id = $1 and m.is_owner and m.active
            and cl.deleted_at is null and cl.subscription_status = $2`,
        [clinicId, status]
      );
      return r.rows;
    });
    for (const o of owners) {
      const sent = await sendEmail({
        to: o.email,
        ...renderEmail({
          type: status === "past_due" ? "payment-overdue" : "account-suspended",
          locale: o.locale === "en" ? "en" : "ar",
          name: o.full_name,
          clinic: o.clinic_name,
          url: `${appUrl()}/c/${o.slug}`,
        }),
      });
      if (!sent.ok && !sent.skipped) console.error("[subscription email]", sent.error);
    }
  } catch (e) {
    console.error("[subscription email]", (e as Error).message);
  }
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

/**
 * Ends support mode: closes the visit, drops the impersonation session and
 * issues a clean admin one — back on the clinic's page, where the visit that
 * just ended is the top line of the record.
 */
export async function exitImpersonationAction() {
  const s = await requireSuperAdmin();
  const { token, slug } = await withSystem(async (c) => {
    let slug: string | null = null;
    if (s.supportVisit) {
      // Before the session goes, so the trigger finds it closed and leaves
      // the reason as "exit" rather than "signed out".
      const r = await c.query(
        `update support_visits sv set ended_at = now(), end_reason = 'exit'
           from clinics cl
          where sv.id = $1 and sv.ended_at is null and cl.id = sv.clinic_id
          returning cl.slug`,
        [s.supportVisit.id]
      );
      slug = (r.rows[0]?.slug as string | undefined) ?? null;
    }
    if (s.impersonatedBy) {
      await audit(c, {
        clinicId: s.supportVisit?.clinicId ?? null,
        userId: s.user.id,
        impersonatedBy: s.impersonatedBy,
        action: "admin.impersonate.end",
        entity: s.supportVisit ? "support_visit" : "",
        entityId: s.supportVisit?.id ?? "",
      });
    }
    await c.query(`delete from sessions where id = $1`, [s.sessionId]);
    return { token: await insertSession(c, s.user.id), slug };
  });
  await setSessionCookie(token);
  redirect(slug ? `/admin/clinics/${slug}` : "/admin");
}

/**
 * Support-mode entry: opens a visit, with its reason, and a session bound to it.
 *
 * The visit, its audit row and the session commit together. Whatever session
 * this request arrived on is deleted in the same transaction: its cookie is
 * about to be overwritten, so nothing can present it again, and if it was a
 * visit to another clinic, going from one to the next ends that one — two
 * visits open at once would each claim the time spent in the other.
 */
export async function impersonateAction(
  clinicSlug: string,
  reason: string
): Promise<{ error: "reason" | "not_found" } | void> {
  const s = await requireAdminCap("clinics.impersonate");
  const why = cleanSupportReason(reason);
  if (!why) return { error: "reason" };
  const ip = await actionIp();
  const ua = (await headers()).get("user-agent")?.slice(0, 400) ?? null;

  const token = await withSystem(async (c) => {
    const r = await c.query("select id from clinics where slug = $1 and deleted_at is null", [
      clinicSlug,
    ]);
    if (!r.rowCount) return null;
    const clinicId = r.rows[0].id as string;
    if (s.supportVisit) {
      await c.query(
        `update support_visits set ended_at = now(), end_reason = 'switched'
          where id = $1 and ended_at is null`,
        [s.supportVisit.id]
      );
    }
    const v = await c.query(
      `insert into support_visits
         (clinic_id, admin_user_id, admin_name, admin_email, reason, ip, user_agent, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + interval '${SUPPORT_VISIT_HOURS} hours')
       returning id`,
      [clinicId, s.user.id, s.user.fullName, s.user.email, why, ip, ua]
    );
    const visitId = v.rows[0].id as string;
    await audit(c, {
      clinicId,
      userId: s.user.id,
      impersonatedBy: s.user.id,
      action: "admin.impersonate.start",
      entity: "support_visit",
      entityId: visitId,
      detail: { reason: why },
    });
    await c.query(`delete from sessions where id = $1`, [s.sessionId]);
    return insertSession(c, s.user.id, {
      impersonatedBy: s.user.id,
      supportVisitId: visitId,
      userAgent: ua ?? undefined,
    });
  });
  if (!token) return { error: "not_found" };
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
  revalidatePath("/admin/defaults");
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
  revalidatePath("/admin/defaults");
}
