/**
 * Document signing: the logic that has to be right.
 *
 * Deliberately not a browser test — this exercises the integrity guarantees, the
 * token lifecycle and the multi-signer orchestration directly against the
 * database, because those are the parts where a subtle regression produces a
 * document that looks fine and is worthless. The browser pass
 * (`qa-esign-browser.ts`) covers what a patient sees.
 *
 * Needs Postgres. The PDF assertions need the worker and the web app too, and
 * are skipped with a warning when they are not reachable.
 */
// Must precede every other import: the PDF client captures INTERNAL_API_SECRET
// and WORKER_URL, and without .env it would fall back to the dev defaults and be
// rejected by a worker that is running with the real ones.
try {
  process.loadEnvFile?.();
} catch {
  /* no .env — rely on the real environment */
}

import { Client, Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";

import {
  buildDefaultSigners,
  createDocument,
  freezeDocument,
  isMinor,
  loadSigners,
  signersDueNow,
  verifyHash,
  acquireLock,
  releaseLock,
  voidDocument,
  refreshDocumentStatus,
  BODY_OVERRIDE_KEY,
} from "../src/lib/esign/documents";
import { buildMergeTable } from "../src/lib/esign/documents";
import { sendDocument } from "../src/lib/esign/flow";
import { recordSignature, declineDocument, markViewed } from "../src/lib/esign/signing";
import { issueSigningToken, lookupToken, consumeToken, hashToken } from "../src/lib/esign/tokens";
import { documentHash, sanitizeHtml, renderTokens } from "../src/lib/esign/render";
import { loadDocumentDetail, loadAppointmentDocuments } from "../src/lib/esign/queries";
import { saveSigningSession, resolveIn } from "../src/lib/esign/public";
import { generateFinalPdf } from "../src/lib/esign/pdf";

const SUPER = `postgres://postgres:postgres@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;
const APP = `postgres://clinicos_app:clinicos_app@127.0.0.1:${process.env.PG_PORT || 5544}/clinicos`;

let passed = 0;
const failures: string[] = [];

function ok(label: string) {
  passed++;
  console.log(`✓ ${label}`);
}
function fail(label: string, detail?: unknown) {
  failures.push(`${label}${detail ? ` — ${String(detail)}` : ""}`);
  console.log(`✗ ${label}${detail ? ` — ${String(detail)}` : ""}`);
}
function check(cond: unknown, label: string, detail?: unknown) {
  if (cond) ok(label);
  else fail(label, detail);
}

/** A 1x1 transparent PNG, valid enough for the signature validator. */
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const pool = new Pool({ connectionString: SUPER, max: 4 });

/** Runs fn in the admin context, like the worker does. */
async function sys<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.is_admin', 'true', true)");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

type Fixture = {
  clinicId: string;
  slug: string;
  ownerId: string;
  doctorUserId: string;
  doctorMemberId: string;
  patientId: string;
  minorId: string;
  noPhoneId: string;
  serviceId: string;
  appointmentId: string;
  templateId: string;
  ownerOnlyTemplateId: string;
  noPhoneTemplateId: string;
};

async function setup(): Promise<Fixture> {
  return sys(async (c) => {
    const tag = randomUUID().slice(0, 8);
    const slug = `qa-esign-${tag}`;
    const clinic = await c.query(
      `insert into clinics (name, name_ar, slug, phone_e164, address, address_ar, default_locale, timezone)
       values ('QA Esign', 'عيادة التوقيع', $1, '+962790000001', '12 Test St', 'شارع الاختبار ١٢', 'ar', 'Asia/Amman')
       returning id`,
      [slug]
    );
    const clinicId = clinic.rows[0].id as string;
    await c.query(`select seed_esign_defaults($1)`, [clinicId]);
    // Signing links must be live long enough for the whole suite.
    await c.query(`update clinics set esign_link_days = 7 where id = $1`, [clinicId]);
    /*
      A connected WhatsApp session. Without one the delivery assertions test
      nothing: the code correctly declines to send when the clinic is offline, so
      the "signed copy reaches the patient" check would pass vacuously by never
      running. The worker still puts nothing on the wire without a real device.
    */
    await c.query(`insert into whatsapp_sessions (clinic_id, status) values ($1, 'connected')`, [
      clinicId,
    ]);

    const owner = await c.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'QA Owner') returning id`,
      [`owner-${tag}@qa.local`]
    );
    const ownerId = owner.rows[0].id as string;
    await c.query(`insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'owner')`, [
      clinicId,
      ownerId,
    ]);

    const doctor = await c.query(
      `insert into users (email, password_hash, full_name) values ($1, 'x', 'د. سارة خالد') returning id`,
      [`doc-${tag}@qa.local`]
    );
    const doctorUserId = doctor.rows[0].id as string;
    const member = await c.query(
      `insert into clinic_members (clinic_id, user_id, role) values ($1, $2, 'doctor') returning id`,
      [clinicId, doctorUserId]
    );
    const doctorMemberId = member.rows[0].id as string;

    const patient = await c.query(
      `insert into patients (clinic_id, full_name, phone_e164, birth_date, gender, custom_fields)
       values ($1, 'أحمد محمد العلي', '+962790000002', '1990-04-11', 'male', '{"national_id":"9901234567","address":"عمان، الدوار الخامس"}')
       returning id`,
      [clinicId]
    );
    const minor = await c.query(
      `insert into patients (clinic_id, full_name, phone_e164, birth_date, gender, custom_fields)
       values ($1, 'ليان أحمد', '+962790000003', $2, 'female', '{"national_id":"2201234567","address":"عمان"}')
       returning id`,
      [clinicId, DateTime.now().minus({ years: 9 }).toISODate()]
    );
    const noPhone = await c.query(
      `insert into patients (clinic_id, full_name, birth_date, custom_fields)
       values ($1, 'سامي بلا هاتف', '1985-01-01', '{"national_id":"8501234567","address":"إربد"}')
       returning id`,
      [clinicId]
    );

    const service = await c.query(
      `insert into services (clinic_id, name, name_ar, duration_min, price)
       values ($1, 'Root canal', 'حشو عصب', 60, 120) returning id`,
      [clinicId]
    );
    const serviceId = service.rows[0].id as string;

    const appt = await c.query(
      `insert into appointments (clinic_id, patient_id, doctor_member_id, service_id, starts_at, ends_at, status)
       values ($1, $2, $3, $4, now() + interval '2 days', now() + interval '2 days 1 hour', 'scheduled')
       returning id`,
      [clinicId, patient.rows[0].id, doctorMemberId, serviceId]
    );

    const body = sanitizeHtml(
      `<p>أنا {{patient.full_name}}، رقمي الوطني {{patient.national_id}}، هاتفي {{patient.phone}}.</p>
       <p>أوافق على {{service.name}} بمبلغ {{service.price}} في {{clinic.name}} على يد {{doctor.name}}.</p>
       <p>التاريخ: {{today}}</p>`
    );
    const template = await c.query(
      `insert into document_templates
         (clinic_id, name, name_ar, category, body, body_ar, language, signer_config, created_by)
       values ($1, 'QA consent', 'موافقة الاختبار', 'consent', $2, $2, 'both', $3, $4)
       returning id`,
      [
        clinicId,
        body,
        JSON.stringify({
          mode: "sequential",
          signers: [
            { role_key: "patient", required: true, order: 0 },
            { role_key: "doctor", required: true, order: 1 },
          ],
        }),
        ownerId,
      ]
    );

    const ownerOnly = await c.query(
      `insert into document_templates
         (clinic_id, name, name_ar, category, body, body_ar, language, signer_config, created_by)
       values ($1, 'Clinic guarantee', 'ضمان العيادة', 'financial',
               '<p>تتعهد {{clinic.name}} بضمان {{service.name}}.</p>',
               '<p>تتعهد {{clinic.name}} بضمان {{service.name}}.</p>', 'both', $2, $3)
       returning id`,
      [
        clinicId,
        JSON.stringify({
          mode: "sequential",
          signers: [{ role_key: "clinic_owner", required: true, order: 0 }],
        }),
        ownerId,
      ]
    );

    // A form that never prints the patient's phone, so the no-number case reaches
    // the delivery step instead of being stopped by a blank merge field first.
    const noPhoneTemplate = await c.query(
      `insert into document_templates
         (clinic_id, name, name_ar, category, body, body_ar, language, signer_config, created_by)
       values ($1, 'Privacy notice', 'إشعار خصوصية', 'privacy',
               '<p>أنا {{patient.full_name}} أوافق على سياسة {{clinic.name}}.</p>',
               '<p>أنا {{patient.full_name}} أوافق على سياسة {{clinic.name}}.</p>', 'both', $2, $3)
       returning id`,
      [
        clinicId,
        JSON.stringify({
          mode: "sequential",
          signers: [{ role_key: "patient", required: true, order: 0 }],
        }),
        ownerId,
      ]
    );

    // The service requires the consent form, so the appointment panel has
    // something to report and the confirm hook has something to raise.
    await c.query(
      `insert into service_documents (clinic_id, service_id, template_id, auto_send)
       values ($1, $2, $3, true)`,
      [clinicId, serviceId, template.rows[0].id]
    );

    return {
      clinicId,
      slug,
      ownerId,
      doctorUserId,
      doctorMemberId,
      patientId: patient.rows[0].id,
      minorId: minor.rows[0].id,
      noPhoneId: noPhone.rows[0].id,
      serviceId,
      appointmentId: appt.rows[0].id,
      templateId: template.rows[0].id,
      ownerOnlyTemplateId: ownerOnly.rows[0].id,
      noPhoneTemplateId: noPhoneTemplate.rows[0].id,
    };
  });
}

/* ------------------------------------------------------------------ suites */

async function testMergeAndFreeze(f: Fixture) {
  // A document whose patient is missing a value must not be sendable.
  const blocked = await sys(async (c) => {
    await c.query(`update patients set custom_fields = '{}'::jsonb where id = $1`, [f.patientId]);
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: { mode: "sequential", signers: [{ role_key: "patient", required: true, order: 0 }] },
      patient: { id: f.patientId, full_name: "أحمد محمد العلي", phone_e164: "+962790000002", birth_date: "1990-04-11" },
      appointmentId: f.appointmentId,
    });
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.patientId,
      templateId: f.templateId,
      title: "موافقة الاختبار",
      language: "ar",
      appointmentId: f.appointmentId,
      serviceId: f.serviceId,
      signers,
    });
    const r = await sendDocument(c, { clinicId: f.clinicId, documentId: id, userId: f.ownerId });
    return { id, r };
  });
  check(
    !blocked.r.ok && blocked.r.error === "missing_fields",
    "a missing merge value blocks sending",
    blocked.r.ok ? "it sent anyway" : blocked.r.error
  );
  check(
    !blocked.r.ok && (blocked.r.missing ?? []).includes("patient.national_id"),
    "the blocked send names the empty field",
    JSON.stringify(blocked.r.ok ? [] : blocked.r.missing)
  );

  // An override on the document unblocks it without touching the patient record.
  const unblocked = await sys(async (c) => {
    await c.query(
      `insert into document_field_values
         (clinic_id, document_id, field_key, label, label_ar, value, is_override, sort)
       values ($1, $2, 'patient.national_id', 'National ID', 'الرقم الوطني', '9901234567', true, 1)`,
      [f.clinicId, blocked.id]
    );
    const r = await sendDocument(c, {
      clinicId: f.clinicId,
      documentId: blocked.id,
      userId: f.ownerId,
    });
    const patient = await c.query(`select custom_fields from patients where id = $1`, [f.patientId]);
    const doc = await c.query(`select content_snapshot, content_hash from documents where id = $1`, [
      blocked.id,
    ]);
    return { r, patient: patient.rows[0].custom_fields, doc: doc.rows[0] };
  });
  check(unblocked.r.ok, "a per-document override unblocks the send", unblocked.r.ok ? "" : unblocked.r.error);
  check(
    Object.keys(unblocked.patient ?? {}).length === 0,
    "the override did not write back to the patient record"
  );
  check(
    unblocked.doc.content_snapshot?.includes("9901234567"),
    "the frozen snapshot carries the overridden value"
  );
  check(
    documentHash(unblocked.doc.content_snapshot) === unblocked.doc.content_hash,
    "the stored hash matches the stored snapshot"
  );

  // Restore, then prove that editing the template afterwards changes nothing.
  const frozenAfterEdit = await sys(async (c) => {
    await c.query(
      `update patients set custom_fields = '{"national_id":"9901234567","address":"عمان، الدوار الخامس"}'::jsonb where id = $1`,
      [f.patientId]
    );
    const before = (
      await c.query(`select content_snapshot, content_hash from documents where id = $1`, [blocked.id])
    ).rows[0];
    await c.query(
      `update document_templates set body_ar = '<p>WORDING CHANGED ENTIRELY</p>', version = version + 1 where id = $1`,
      [f.templateId]
    );
    const after = (
      await c.query(`select content_snapshot, content_hash from documents where id = $1`, [blocked.id])
    ).rows[0];
    // Put the template back for the rest of the suite.
    await c.query(
      `update document_templates set body_ar = body where id = $1`,
      [f.templateId]
    );
    return { before, after };
  });
  check(
    frozenAfterEdit.before.content_hash === frozenAfterEdit.after.content_hash &&
      frozenAfterEdit.before.content_snapshot === frozenAfterEdit.after.content_snapshot,
    "rewriting the template does not touch a document already sent"
  );

  return blocked.id;
}

async function testTokenLifecycle(f: Fixture, documentId: string) {
  const issued = await sys(async (c) => {
    const signers = await loadSigners(c, documentId, f.clinicId);
    const patientSigner = signers.find((s) => s.role_key === "patient")!;
    const first = await issueSigningToken(c, {
      clinicId: f.clinicId,
      documentId,
      signerId: patientSigner.id,
      days: 7,
    });
    // Re-issuing must kill the previous link, or two live links exist at once.
    const second = await issueSigningToken(c, {
      clinicId: f.clinicId,
      documentId,
      signerId: patientSigner.id,
      days: 7,
    });
    const firstLookup = await lookupToken(c, first.token);
    const secondLookup = await lookupToken(c, second.token);
    return { first, second, firstLookup, secondLookup, signerId: patientSigner.id };
  });
  check(
    !issued.firstLookup.ok && issued.firstLookup.reason === "revoked",
    "issuing a new link revokes the previous one",
    issued.firstLookup.ok ? "old link still valid" : issued.firstLookup.reason
  );
  check(issued.secondLookup.ok, "the newest link resolves");

  const tokenLen = Buffer.from(issued.second.token, "base64url").length;
  check(tokenLen >= 32, "the token carries at least 32 random bytes", tokenLen);

  const stored = await sys((c) =>
    c.query(`select 1 from signing_tokens where token_hash = $1`, [hashToken(issued.second.token)])
  );
  check((stored.rowCount ?? 0) === 1, "the token is stored only as a SHA-256 digest");
  const raw = await sys((c) =>
    c.query(`select 1 from signing_tokens where token_hash = $1`, [issued.second.token])
  );
  check((raw.rowCount ?? 0) === 0, "the raw token is nowhere in the table");

  // Expiry
  const expired = await sys(async (c) => {
    const t = await issueSigningToken(c, {
      clinicId: f.clinicId,
      documentId,
      signerId: issued.signerId,
      days: 7,
    });
    await c.query(`update signing_tokens set expires_at = now() - interval '1 day' where signer_id = $1`, [
      issued.signerId,
    ]);
    const lookup = await lookupToken(c, t.token);
    const view = await resolveIn(c, t.token, { countAttempt: false });
    return { lookup, view };
  });
  check(
    !expired.lookup.ok && expired.lookup.reason === "expired",
    "an expired link is refused"
  );
  check(
    expired.view.state === "expired" && expired.view.clinic !== null,
    "the expired screen still knows the clinic, so it can be branded and offer a next action",
    expired.view.state
  );

  // Single use
  const reused = await sys(async (c) => {
    const t = await issueSigningToken(c, {
      clinicId: f.clinicId,
      documentId,
      signerId: issued.signerId,
      days: 7,
    });
    const before = await lookupToken(c, t.token);
    await consumeToken(c, before.ok ? before.row.id : "");
    const after = await lookupToken(c, t.token);
    return { before, after, token: t.token };
  });
  check(reused.before.ok, "a fresh link resolves once");
  check(
    !reused.after.ok && reused.after.reason === "used",
    "the same link cannot be used twice"
  );

  return issued.signerId;
}

async function testSequentialSigning(f: Fixture) {
  const built = await sys(async (c) => {
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: {
        mode: "sequential",
        signers: [
          { role_key: "patient", required: true, order: 0 },
          { role_key: "doctor", required: true, order: 1 },
        ],
      },
      patient: {
        id: f.patientId,
        full_name: "أحمد محمد العلي",
        phone_e164: "+962790000002",
        birth_date: "1990-04-11",
      },
      appointmentId: f.appointmentId,
    });
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.patientId,
      templateId: f.templateId,
      title: "موافقة تسلسلية",
      language: "ar",
      appointmentId: f.appointmentId,
      serviceId: f.serviceId,
      signers,
    });
    const sent = await sendDocument(c, { clinicId: f.clinicId, documentId: id, userId: f.ownerId });
    const rows = await loadSigners(c, id, f.clinicId);
    return { id, sent, rows };
  });
  check(built.sent.ok, "a sequential document sends", built.sent.ok ? "" : built.sent.error);
  check(
    built.rows.find((s) => s.role_key === "doctor")?.user_id === f.doctorUserId,
    "the doctor signer resolved to the appointment's doctor"
  );

  const due = signersDueNow(built.rows, "sequential");
  check(
    due.length === 1 && due[0].role_key === "patient",
    "only the first signer is due in sequential mode",
    due.map((d) => d.role_key).join(",")
  );

  // The doctor cannot jump the queue.
  const outOfTurn = await sys(async (c) => {
    const doctor = built.rows.find((s) => s.role_key === "doctor")!;
    return recordSignature(c, {
      clinicId: f.clinicId,
      documentId: built.id,
      signerId: doctor.id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
    });
  });
  check(
    !outOfTurn.ok && outOfTurn.error === "not_your_turn",
    "a later signer cannot sign out of turn",
    outOfTurn.ok ? "it allowed it" : outOfTurn.error
  );

  // Consent is mandatory.
  const noConsent = await sys(async (c) => {
    const patient = built.rows.find((s) => s.role_key === "patient")!;
    return recordSignature(c, {
      clinicId: f.clinicId,
      documentId: built.id,
      signerId: patient.id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: false },
    });
  });
  check(
    !noConsent.ok && noConsent.error === "consent_required",
    "a signature without the consent box is refused"
  );

  // A junk image is refused.
  const junk = await sys(async (c) => {
    const patient = built.rows.find((s) => s.role_key === "patient")!;
    return recordSignature(c, {
      clinicId: f.clinicId,
      documentId: built.id,
      signerId: patient.id,
      input: { pngDataUrl: "data:image/png;base64,bm90LWEtcG5n", consentConfirmed: true },
    });
  });
  check(
    !junk.ok && junk.error === "bad_signature",
    "a payload that is not really a PNG is refused"
  );

  // The patient signs. Status becomes partially signed, not completed.
  const afterPatient = await sys(async (c) => {
    const patient = built.rows.find((s) => s.role_key === "patient")!;
    const r = await recordSignature(c, {
      clinicId: f.clinicId,
      documentId: built.id,
      signerId: patient.id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
      ip: "203.0.113.9",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
    });
    const rows = await loadSigners(c, built.id, f.clinicId);
    return { r, rows };
  });
  check(
    afterPatient.r.ok && afterPatient.r.documentStatus === "partially_signed",
    "one of two signatures leaves the document partially signed",
    afterPatient.r.ok ? afterPatient.r.documentStatus : afterPatient.r.error
  );
  check(
    !afterPatient.r.ok || !afterPatient.r.completed,
    "the patient leaving before the doctor does not complete the document"
  );
  const nowDue = signersDueNow(afterPatient.rows, "sequential");
  check(
    nowDue.length === 1 && nowDue[0].role_key === "doctor",
    "the doctor becomes due once the patient has signed"
  );

  // Doctor countersigns → completed.
  const afterDoctor = await sys(async (c) => {
    const doctor = afterPatient.rows.find((s) => s.role_key === "doctor")!;
    return recordSignature(c, {
      clinicId: f.clinicId,
      documentId: built.id,
      signerId: doctor.id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
      actorUserId: f.doctorUserId,
    });
  });
  check(
    afterDoctor.ok && afterDoctor.completed,
    "the countersignature completes the document",
    afterDoctor.ok ? "" : afterDoctor.error
  );

  // Immutable afterwards.
  const afterComplete = await sys(async (c) => {
    const rows = await loadSigners(c, built.id, f.clinicId);
    return recordSignature(c, {
      clinicId: f.clinicId,
      documentId: built.id,
      signerId: rows[0].id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
    });
  });
  check(
    !afterComplete.ok && afterComplete.error === "terminal",
    "a completed document accepts nothing further"
  );

  return built.id;
}

async function testHashMismatchRefusal(f: Fixture) {
  const result = await sys(async (c) => {
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: { mode: "sequential", signers: [{ role_key: "patient", required: true, order: 0 }] },
      patient: {
        id: f.patientId,
        full_name: "أحمد محمد العلي",
        phone_e164: "+962790000002",
        birth_date: "1990-04-11",
      },
      appointmentId: f.appointmentId,
    });
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.patientId,
      templateId: f.templateId,
      title: "موافقة السلامة",
      language: "ar",
      appointmentId: f.appointmentId,
      serviceId: f.serviceId,
      signers,
    });
    await freezeDocument(c, f.clinicId, id);

    // Tamper with the frozen copy, exactly what the hash exists to catch.
    await c.query(
      `update documents set content_snapshot = content_snapshot || '<p>SNEAKY EXTRA CLAUSE</p>' where id = $1`,
      [id]
    );
    const doc = (await c.query(`select * from documents where id = $1`, [id])).rows[0];
    const verified = verifyHash(doc);

    const rows = await loadSigners(c, id, f.clinicId);
    const attempt = await recordSignature(c, {
      clinicId: f.clinicId,
      documentId: id,
      signerId: rows[0].id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
    });
    const events = await c.query(
      `select event_type from document_events where document_id = $1 and event_type = 'hash_mismatch'`,
      [id]
    );
    const notices = await c.query(
      `select count(*)::int as n from notifications
       where clinic_id = $1 and kind = 'document_integrity'`,
      [f.clinicId]
    );
    return { verified, attempt, events: events.rowCount ?? 0, notices: notices.rows[0].n };
  });

  check(!result.verified, "a tampered snapshot fails its hash check");
  check(
    !result.attempt.ok && result.attempt.error === "hash_mismatch",
    "a tampered document refuses the signature",
    result.attempt.ok ? "it signed anyway" : result.attempt.error
  );
  check(result.events > 0, "the mismatch is written to the append-only audit trail");
  check(result.notices > 0, "the clinic owner and the agency are notified of the mismatch");
}

async function testAppendOnlyAudit(f: Fixture) {
  const documentId = await sys(async (c) => {
    const r = await c.query(`select id from documents where clinic_id = $1 limit 1`, [f.clinicId]);
    return r.rows[0].id as string;
  });

  for (const [sql, label] of [
    [`update document_events set event_type = 'viewed' where document_id = $1`, "a targeted UPDATE"],
    [`delete from document_events where document_id = $1`, "a targeted DELETE"],
  ] as const) {
    // A separate client: the failure aborts the transaction it happens in.
    const c = new Client({ connectionString: SUPER });
    await c.connect();
    let blocked = false;
    try {
      await c.query("begin");
      await c.query("select set_config('app.is_admin', 'true', true)");
      await c.query(sql, [documentId]);
      await c.query("commit");
    } catch (e) {
      blocked = /append-only/i.test((e as Error).message);
      await c.query("rollback").catch(() => {});
    } finally {
      await c.end();
    }
    check(blocked, `the database rejects ${label} on document_events`);
  }

  /*
    The other half of the rule, and the one that regressed: removing a patient (or
    a clinic) has to take its documents and their events with it. A trigger that
    refuses the cascade does not protect anything — it just makes a tenant
    undeletable.
  */
  const cascade = await sys(async (c) => {
    const p = await c.query(
      `insert into patients (clinic_id, full_name, phone_e164, birth_date, custom_fields)
       values ($1, 'مريض مؤقت', '+962790000099', '1980-01-01', '{"national_id":"1","address":"x"}')
       returning id`,
      [f.clinicId]
    );
    const patientId = p.rows[0].id as string;
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId,
      templateId: f.noPhoneTemplateId,
      title: "مستند مؤقت",
      language: "ar",
      signers: [{ roleKey: "patient", order: 0, required: true, displayName: "مريض مؤقت", phone: "+962790000099" }],
    });
    const before = (
      await c.query(`select count(*)::int as n from document_events where document_id = $1`, [id])
    ).rows[0].n;
    await c.query(`delete from patients where id = $1`, [patientId]);
    const after = (
      await c.query(`select count(*)::int as n from document_events where document_id = $1`, [id])
    ).rows[0].n;
    const docsLeft = (
      await c.query(`select count(*)::int as n from documents where id = $1`, [id])
    ).rows[0].n;
    return { before, after, docsLeft };
  });
  check(cascade.before > 0, "the temporary document had events to begin with", cascade.before);
  check(
    cascade.docsLeft === 0 && cascade.after === 0,
    "deleting a patient still cascades through their documents and events",
    `docs=${cascade.docsLeft} events=${cascade.after}`
  );
}

async function testGuardianAndEdgeCases(f: Fixture) {
  check(isMinor(DateTime.now().minus({ years: 9 }).toISODate()), "a nine-year-old is a minor");
  check(!isMinor("1990-04-11"), "an adult is not");
  check(!isMinor(null), "an unknown birth date does not force a guardian");

  // A minor gains a guardian even when the template does not ask for one.
  const minorSigners = await sys((c) =>
    buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: { mode: "sequential", signers: [{ role_key: "patient", required: true, order: 0 }] },
      patient: {
        id: f.minorId,
        full_name: "ليان أحمد",
        phone_e164: "+962790000003",
        birth_date: DateTime.now().minus({ years: 9 }).toISODate(),
      },
    })
  );
  check(
    minorSigners.some((s) => s.roleKey === "guardian" && s.required !== false),
    "a patient under 18 automatically gains a required guardian signer",
    minorSigners.map((s) => s.roleKey).join(",")
  );

  // A patient with no WhatsApp number: the send reports it rather than failing quietly.
  const noPhone = await sys(async (c) => {
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: { mode: "sequential", signers: [{ role_key: "patient", required: true, order: 0 }] },
      patient: { id: f.noPhoneId, full_name: "سامي بلا هاتف", phone_e164: null, birth_date: "1985-01-01" },
    });
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.noPhoneId,
      templateId: f.noPhoneTemplateId,
      title: "إشعار خصوصية بلا هاتف",
      language: "ar",
      serviceId: f.serviceId,
      signers,
    });
    return sendDocument(c, { clinicId: f.clinicId, documentId: id, userId: f.ownerId });
  });
  check(
    noPhone.ok && noPhone.noPhone.length === 1 && noPhone.delivered === 0,
    "a patient with no number is reported as unreachable, not silently skipped",
    JSON.stringify(noPhone.ok ? noPhone.noPhone : noPhone.error)
  );

  // An owner-only document needs no patient involvement at all.
  const ownerOnly = await sys(async (c) => {
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: {
        mode: "sequential",
        signers: [{ role_key: "clinic_owner", required: true, order: 0 }],
      },
      patient: null,
    });
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.patientId,
      templateId: f.ownerOnlyTemplateId,
      title: "ضمان العيادة",
      language: "ar",
      serviceId: f.serviceId,
      signers,
    });
    const sent = await sendDocument(c, { clinicId: f.clinicId, documentId: id, userId: f.ownerId });
    const rows = await loadSigners(c, id, f.clinicId);
    const signed = await recordSignature(c, {
      clinicId: f.clinicId,
      documentId: id,
      signerId: rows[0].id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
      actorUserId: f.ownerId,
    });
    return { id, sent, rows, signed };
  });
  check(
    ownerOnly.rows.length === 1 && ownerOnly.rows[0].user_id === f.ownerId,
    "an owner-only document has exactly one signer, resolved to the owner"
  );
  check(
    ownerOnly.sent.ok && ownerOnly.sent.delivered === 0 && ownerOnly.sent.staffNotified === 1,
    "an owner-only document sends nothing to the patient",
    JSON.stringify(ownerOnly.sent)
  );
  check(
    ownerOnly.signed.ok && ownerOnly.signed.completed,
    "the owner signing alone completes the document"
  );
  const filed = await sys((c) =>
    c.query(`select patient_id from documents where id = $1`, [ownerOnly.id])
  );
  check(
    filed.rows[0].patient_id === f.patientId,
    "it still files into the patient's record"
  );

  // Voiding keeps the record and requires a reason.
  const voided = await sys(async (c) => {
    const noReason = await voidDocument(c, {
      clinicId: f.clinicId,
      documentId: ownerOnly.id,
      userId: f.ownerId,
      reason: "   ",
    });
    const withReason = await voidDocument(c, {
      clinicId: f.clinicId,
      documentId: ownerOnly.id,
      userId: f.ownerId,
      reason: "صدر بالخطأ لمريض آخر",
    });
    const doc = (
      await c.query(`select status, void_reason, content_snapshot from documents where id = $1`, [
        ownerOnly.id,
      ])
    ).rows[0];
    return { noReason, withReason, doc };
  });
  check(voided.noReason.error === "reason_required", "voiding without a reason is refused");
  check(
    voided.withReason.error === undefined && voided.doc.status === "voided",
    "voiding with a reason succeeds"
  );
  check(
    !!voided.doc.content_snapshot && !!voided.doc.void_reason,
    "a voided document keeps its content and its reason"
  );
}

async function testLockingAndResume(f: Fixture) {
  const doc = await sys(async (c) => {
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: { mode: "sequential", signers: [{ role_key: "patient", required: true, order: 0 }] },
      patient: {
        id: f.patientId,
        full_name: "أحمد محمد العلي",
        phone_e164: "+962790000002",
        birth_date: "1990-04-11",
      },
      appointmentId: f.appointmentId,
    });
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.patientId,
      templateId: f.templateId,
      title: "موافقة الجهاز",
      language: "ar",
      appointmentId: f.appointmentId,
      serviceId: f.serviceId,
      signers,
    });
    await sendDocument(c, { clinicId: f.clinicId, documentId: id, userId: f.ownerId });
    const mine = await acquireLock(c, f.clinicId, id, f.ownerId);
    const theirs = await acquireLock(c, f.clinicId, id, f.doctorUserId);
    return { id, mine, theirs };
  });
  check(doc.mine.ok, "the first staff member claims the document for their device");
  check(
    !doc.theirs.ok && doc.theirs.heldBy === "QA Owner",
    "a second staff member is told who is holding it",
    JSON.stringify(doc.theirs)
  );

  const released = await sys(async (c) => {
    await releaseLock(c, f.clinicId, doc.id, f.ownerId);
    return acquireLock(c, f.clinicId, doc.id, f.doctorUserId);
  });
  check(released.ok, "releasing the lock lets the next device claim it");

  const stale = await sys(async (c) => {
    await c.query(`update documents set locked_at = now() - interval '2 hours' where id = $1`, [doc.id]);
    return acquireLock(c, f.clinicId, doc.id, f.ownerId);
  });
  check(stale.ok, "a forgotten lock times out rather than wedging the document");

  // Resume: a half-drawn signature survives an abandoned session.
  const resumed = await sys(async (c) => {
    const rows = await loadSigners(c, doc.id, f.clinicId);
    await saveSigningSession(c, {
      clinicId: f.clinicId,
      documentId: doc.id,
      signerId: rows[0].id,
      lastStep: 3,
      scrolledToEnd: true,
      consentConfirmed: true,
      partialSignature: { strokes: [[{ x: 1, y: 2, t: 0, p: 0.5 }]] },
      fieldAnswers: { note: "half done" },
    });
    // A later ping at an earlier step must not lose their place.
    await saveSigningSession(c, {
      clinicId: f.clinicId,
      documentId: doc.id,
      signerId: rows[0].id,
      lastStep: 1,
      consentConfirmed: true,
    });
    const t = await issueSigningToken(c, {
      clinicId: f.clinicId,
      documentId: doc.id,
      signerId: rows[0].id,
      days: 7,
    });
    return resolveIn(c, t.token, { countAttempt: false });
  });
  check(
    resumed.session?.lastStep === 3,
    "reopening a link resumes at the furthest step reached",
    resumed.session?.lastStep
  );
  check(
    resumed.session?.scrolledToEnd === true && resumed.session?.consentConfirmed === true,
    "the scroll and the consent box are remembered"
  );
  check(
    Array.isArray((resumed.session?.partialSignature as { strokes?: unknown[] })?.strokes),
    "the partially drawn signature is still there"
  );

  return doc.id;
}

async function testDeclineAndView(f: Fixture) {
  const result = await sys(async (c) => {
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: {
        mode: "sequential",
        signers: [
          { role_key: "patient", required: true, order: 0 },
          { role_key: "doctor", required: true, order: 1 },
        ],
      },
      patient: {
        id: f.patientId,
        full_name: "أحمد محمد العلي",
        phone_e164: "+962790000002",
        birth_date: "1990-04-11",
      },
      appointmentId: f.appointmentId,
    });
    const id = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.patientId,
      templateId: f.templateId,
      title: "موافقة مرفوضة",
      language: "ar",
      appointmentId: f.appointmentId,
      serviceId: f.serviceId,
      signers,
    });
    await sendDocument(c, { clinicId: f.clinicId, documentId: id, userId: f.ownerId });
    const rows = await loadSigners(c, id, f.clinicId);

    await markViewed(c, {
      clinicId: f.clinicId,
      documentId: id,
      signerId: rows[0].id,
      ip: "203.0.113.11",
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Safari/537.36",
      opened: true,
    });
    const viewed = (
      await c.query(`select status, link_opened_at, viewed_at from document_signers where id = $1`, [
        rows[0].id,
      ])
    ).rows[0];

    const declined = await declineDocument(c, {
      clinicId: f.clinicId,
      documentId: id,
      signerId: rows[0].id,
      reason: "أريد مراجعة الطبيب أولاً",
      ip: "203.0.113.11",
    });
    const doc = (
      await c.query(`select status, declined_at from documents where id = $1`, [id])
    ).rows[0];
    const tokens = (
      await c.query(
        `select count(*)::int as live from signing_tokens
         where document_id = $1 and revoked_at is null and used_at is null`,
        [id]
      )
    ).rows[0].live;
    return { id, viewed, declined, doc, tokens };
  });

  check(
    result.viewed.status === "viewed" && !!result.viewed.link_opened_at,
    "opening the link records both the open and the view"
  );
  check(result.declined.ok, "declining succeeds");
  check(result.doc.status === "declined", "one decline sets the whole document to declined");
  check(result.tokens === 0, "declining kills every live link on the document");
}

async function testAppointmentIntegration(f: Fixture) {
  const rows = await sys((c) => loadAppointmentDocuments(c, f.clinicId, f.appointmentId));
  check(
    rows.length >= 1 && rows.some((r) => r.templateId === f.templateId),
    "the appointment panel sees the consent form its service requires",
    rows.length
  );
  check(
    rows.some((r) => r.autoSend),
    "the required form is marked for automatic sending"
  );
}

async function testDetailReadModel(f: Fixture, documentId: string) {
  const detail = await sys((c) => loadDocumentDetail(c, f.clinicId, documentId));
  check(!!detail, "the detail read model loads");
  if (!detail) return;
  check(detail.signers.length > 0, "it lists the signers");
  check(
    detail.events.some((e) => e.event_type === "created"),
    "it carries the audit trail"
  );
  check(
    detail.previewHtml.includes("أحمد") || detail.previewHtml.includes("<"),
    "it renders a preview"
  );
  check(
    !detail.fields.some((x) => x.key === BODY_OVERRIDE_KEY),
    "the reserved body-override key never appears as a merge field"
  );
}

async function testRls(f: Fixture) {
  // A second clinic, to be the victim of the isolation test.
  const other = await sys(async (c) => {
    const r = await c.query(
      `insert into clinics (name, slug) values ('Other QA', $1) returning id`,
      [`qa-other-${randomUUID().slice(0, 8)}`]
    );
    return r.rows[0].id as string;
  });

  const app = new Client({ connectionString: APP });
  await app.connect();
  const tables = [
    "documents",
    "document_signers",
    "document_events",
    "document_templates",
    "document_field_values",
    "signing_tokens",
    "signing_sessions",
    "patient_field_definitions",
    "signer_roles",
  ];
  let leaks = 0;
  for (const table of tables) {
    await app.query("begin");
    await app.query(`select set_config('app.clinic_id', $1, true)`, [other]);
    await app.query(`select set_config('app.is_admin', 'false', true)`);
    const r = await app.query(`select count(*)::int as n from ${table} where clinic_id = $1`, [
      f.clinicId,
    ]);
    await app.query("commit");
    if (r.rows[0].n !== 0) {
      leaks++;
      fail(`RLS leak on ${table}`, r.rows[0].n);
    }
  }
  if (!leaks) ok(`RLS isolates all ${tables.length} signing tables from another clinic`);

  // A cross-tenant insert must be rejected outright.
  let insertBlocked = false;
  try {
    await app.query("begin");
    await app.query(`select set_config('app.clinic_id', $1, true)`, [other]);
    await app.query(`select set_config('app.is_admin', 'false', true)`);
    await app.query(
      `insert into documents (clinic_id, title, language) values ($1, 'stolen', 'en')`,
      [f.clinicId]
    );
    await app.query("commit");
  } catch {
    insertBlocked = true;
    await app.query("rollback").catch(() => {});
  }
  check(insertBlocked, "RLS refuses an insert into another clinic's documents");
  await app.end();
}

async function testPdf(f: Fixture, documentId: string) {
  const reachable = await fetch(`${process.env.APP_URL || "http://localhost:3000"}/login`, {
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => r.ok || r.status < 500)
    .catch(() => false);
  if (!reachable) {
    console.log("⚠ skipped PDF assertions — the web app is not running (npm run dev:all)");
    return;
  }

  const result = await generateFinalPdf(documentId).catch((e) => ({ error: String(e) }));
  if ("error" in result) {
    fail("the finished PDF is generated", result.error);
    return;
  }
  ok("the finished PDF is generated");

  const { readFileBuffer } = await import("../src/lib/storage");
  const buf = await readFileBuffer(result.path);
  check(!!buf && buf.subarray(0, 5).toString("latin1") === "%PDF-", "the stored file is a real PDF");
  check((buf?.length ?? 0) > 8000, "it is a substantial document, not a blank page", buf?.length);

  /*
    The certificate is the final page, always. Counted by parsing the file rather
    than by grepping for `/Type /Page`: the metadata pass re-saves through pdf-lib,
    which packs those objects into compressed object streams where a text scan
    finds nothing.
  */
  const { PDFDocument } = await import("pdf-lib");
  const parsed = await PDFDocument.load(new Uint8Array(buf!), { ignoreEncryption: true });
  check(
    parsed.getPageCount() >= 2,
    "the PDF has at least the document plus the certificate page",
    parsed.getPageCount()
  );
  check(!!parsed.getTitle(), "the PDF carries its title as metadata", parsed.getTitle());

  const stored = await sys((c) =>
    c.query(`select final_pdf_path from documents where id = $1`, [documentId])
  );
  check(!!stored.rows[0].final_pdf_path, "the document records where its PDF is stored");
}

/**
 * The uploaded-PDF path, end to end.
 *
 * The one part of the module where the clinic's own file must come out the other
 * side unchanged apart from what was stamped on it. So this builds a real
 * two-page PDF, places boxes on both pages, signs, and then checks the finished
 * file still has those two pages plus the certificate — and that the overlay
 * actually drew something, which is the step that silently does nothing if the
 * worker's screenshot route or the page-fraction maths breaks.
 */
async function testUploadedPdfPath(f: Fixture) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  for (const label of ["Clinic agreement — page 1", "Schedule of fees — page 2"]) {
    const page = src.addPage([595, 842]); // A4 at 72dpi
    page.drawText(label, { x: 60, y: 760, size: 16, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawText("Signature:", { x: 60, y: 180, size: 12, font });
  }
  const original = Buffer.from(await src.save());

  const { saveFile, readFileBuffer } = await import("../src/lib/storage");
  const stored = await saveFile(f.clinicId, "document-templates", "agreement.pdf", original);

  const built = await sys(async (c) => {
    const tpl = await c.query(
      `insert into document_templates
         (clinic_id, name, name_ar, category, source, source_pdf_path, signer_config, created_by)
       values ($1, 'Uploaded agreement', 'اتفاقية مرفوعة', 'financial', 'upload', $2, $3, $4)
       returning id`,
      [
        f.clinicId,
        stored.storagePath,
        JSON.stringify({
          mode: "sequential",
          signers: [{ role_key: "patient", required: true, order: 0 }],
        }),
        f.ownerId,
      ]
    );
    const templateId = tpl.rows[0].id as string;

    // A signature box on page 1 and a date box on page 2, as page fractions.
    for (const [page, type, y] of [
      [1, "signature", 0.74],
      [2, "date", 0.74],
    ] as const) {
      await c.query(
        `insert into document_fields
           (clinic_id, template_id, page_number, x, y, width, height, field_type, assigned_role_key)
         values ($1, $2, $3, 0.12, $4, 0.3, 0.05, $5, 'patient')`,
        [f.clinicId, templateId, page, y, type]
      );
    }

    const documentId = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.patientId,
      templateId,
      title: "اتفاقية مرفوعة",
      language: "ar",
      source: "upload",
      sourcePdfPath: stored.storagePath,
      signers: [
        {
          roleKey: "patient",
          order: 0,
          required: true,
          displayName: "أحمد محمد العلي",
          phone: "+962790000002",
        },
      ],
    });

    const cloned = await c.query(
      `select count(*)::int as n from document_fields where document_id = $1`,
      [documentId]
    );
    const sent = await sendDocument(c, { clinicId: f.clinicId, documentId, userId: f.ownerId });
    const rows = await loadSigners(c, documentId, f.clinicId);
    const signed = await recordSignature(c, {
      clinicId: f.clinicId,
      documentId,
      signerId: rows[0].id,
      input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
      ip: "203.0.113.20",
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0) AppleWebKit/605.1.15 Safari/604.1",
    });
    return { templateId, documentId, cloned: cloned.rows[0].n, sent, signed };
  });

  check(
    built.cloned === 2,
    "the template's placed boxes are cloned onto the document at creation",
    built.cloned
  );
  check(built.sent.ok, "an uploaded document sends without a merge table", built.sent.ok ? "" : built.sent.error);
  check(
    built.signed.ok && built.signed.completed,
    "an uploaded document completes when its only signer signs",
    built.signed.ok ? "" : built.signed.error
  );

  const result = await generateFinalPdf(built.documentId);
  if ("error" in result) {
    fail("the uploaded document produces a stamped PDF", result.error);
    return;
  }
  ok("the uploaded document produces a stamped PDF");

  const out = await readFileBuffer(result.path);
  if (!out) {
    fail("the stamped PDF is readable from storage");
    return;
  }
  const finished = await PDFDocument.load(new Uint8Array(out), { ignoreEncryption: true });

  check(
    finished.getPageCount() >= 3,
    "the finished file keeps both original pages and appends the certificate",
    finished.getPageCount()
  );
  const [w, h] = [finished.getPage(0).getWidth(), finished.getPage(0).getHeight()];
  check(
    Math.abs(w - 595) < 2 && Math.abs(h - 842) < 2,
    "the original page size is untouched — the file was composited, not re-typeset",
    `${Math.round(w)}×${Math.round(h)}`
  );
  // Original text still present: proof the page was not replaced by an image.
  const raw = out.toString("latin1");
  check(
    out.length > original.length * 1.5,
    "the stamped file is larger than the original, so layers were actually drawn",
    `${original.length} → ${out.length}`
  );
  check(
    finished.getTitle() === "اتفاقية مرفوعة",
    "the stamped file carries its title as metadata",
    finished.getTitle()
  );
  void raw;

  return built.documentId;
}

/**
 * The signed copy reaching the patient, through the real worker job.
 *
 * Enqueues the job the application enqueues and waits for the running worker to
 * process it, rather than calling the handler directly — the brief requires the
 * PDF to land in that patient's own WhatsApp thread, and the only way to know it
 * does is to let the worker do it.
 */
async function testSignedCopyDelivery(f: Fixture, documentId: string) {
  const workerUp = await fetch(`${process.env.WORKER_URL || "http://localhost:4020"}/health`, {
    headers: {
      "x-internal-secret":
        process.env.INTERNAL_API_SECRET || "dev-internal-secret-change-in-production",
    },
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (!workerUp) {
    console.log("⚠ skipped signed-copy delivery — the worker is not running");
    return;
  }

  await sys(async (c) => {
    // Clear the dedupe key so this document can be finalised again for the test.
    await c.query(`delete from jobs where dedupe_key = $1`, [`document:finalize:${documentId}`]);
    await c.query(
      `insert into jobs (clinic_id, kind, payload, dedupe_key)
       values ($1, 'document:finalize', $2, $3)`,
      [f.clinicId, JSON.stringify({ documentId }), `document:finalize:${documentId}`]
    );
  });

  let message: Record<string, unknown> | null = null;
  for (let i = 0; i < 40 && !message; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    message = await sys(async (c) => {
      const r = await c.query(
        `select m.msg_type, m.media_path, m.media_mime, m.body, cv.patient_id, cv.phone_e164
         from messages m join conversations cv on cv.id = m.conversation_id
         where m.clinic_id = $1 and m.msg_type = 'document' and cv.patient_id = $2
         order by m.created_at desc limit 1`,
        [f.clinicId, f.patientId]
      );
      return r.rows[0] ?? null;
    });
  }

  if (!message) {
    fail("the signed PDF is delivered into the patient's WhatsApp thread (worker job timed out)");
    return;
  }
  ok("the signed PDF is delivered into the patient's WhatsApp thread");
  check(message.media_mime === "application/pdf", "it is attached as a PDF", message.media_mime);
  check(!!message.media_path, "the attachment points at the stored file");
  check(
    message.patient_id === f.patientId,
    "it lands in that patient's own thread, not a new one"
  );
  check(
    String(message.body ?? "").length > 20,
    "it carries a short covering message rather than a bare file"
  );
}

/**
 * Several documents waiting for one patient: one message, a numbered list, and a
 * separate single-use link for each — never a combined signing session.
 */
async function testSendAllPending(f: Fixture) {
  const result = await sys(async (c) => {
    // Two fresh drafts for a patient with nothing outstanding.
    const patient = await c.query(
      `insert into patients (clinic_id, full_name, phone_e164, birth_date, custom_fields)
       values ($1, 'مريض الدفعة', '+962790000077', '1979-05-05',
               '{"national_id":"7901234567","address":"عمّان"}') returning id`,
      [f.clinicId]
    );
    const patientId = patient.rows[0].id as string;

    const ids: string[] = [];
    for (const title of ["إشعار أول", "إشعار ثانٍ"]) {
      const id = await createDocument(c, {
        clinicId: f.clinicId,
        userId: f.ownerId,
        patientId,
        templateId: f.noPhoneTemplateId,
        title,
        language: "ar",
        signers: [
          {
            roleKey: "patient",
            order: 0,
            required: true,
            displayName: "مريض الدفعة",
            phone: "+962790000077",
          },
        ],
      });
      ids.push(id);
    }
    return { patientId, ids };
  });

  // The real function the patient tab's action wraps — no re-implementation, so
  // this test would have caught the triple-send it did catch.
  const { sendAllPendingForPatient } = await import("../src/lib/esign/flow");
  const bundled = await sys((c) =>
    sendAllPendingForPatient(c, {
      clinicId: f.clinicId,
      patientId: result.patientId,
      userId: f.ownerId,
    })
  );

  check(bundled.ok, "send-all-pending succeeds", bundled.ok ? "" : bundled.error);
  if (!bundled.ok) return;
  check(bundled.sent === 2, "both pending documents were included", bundled.sent);

  const sentMessages = await sys(async (c) => {
    const r = await c.query(
      `select m.body from messages m join conversations cv on cv.id = m.conversation_id
       where cv.patient_id = $1 order by m.created_at`,
      [result.patientId]
    );
    return r.rows.map((x) => x.body as string);
  });
  check(
    sentMessages.length === 1,
    "it is one message, not one per document",
    sentMessages.length
  );
  const body = sentMessages[0] ?? "";
  const links = body.match(/\/sign\/[A-Za-z0-9_-]+/g) ?? [];
  check(links.length === 2, "the single message carries one link per document", links.length);
  check(new Set(links).size === 2, "the two links are different — no shared signing session");
  check(/1\./.test(body) && /2\./.test(body), "the list is numbered");

  // Each link still resolves to its own document.
  const resolved = await sys(async (c) => {
    const out: string[] = [];
    for (const l of links) {
      const token = l.replace("/sign/", "");
      const view = await resolveIn(c, token, { countAttempt: false });
      out.push(view.document?.id ?? "none");
    }
    return out;
  });
  check(
    new Set(resolved).size === 2 && !resolved.includes("none"),
    "each link opens its own document",
    resolved.join(",")
  );
}

/**
 * An under-18 patient: the guardian is required, their relationship is captured,
 * and both signatures reach the certificate.
 */
async function testGuardianOnCertificate(f: Fixture) {
  const built = await sys(async (c) => {
    const signers = await buildDefaultSigners(c, {
      clinicId: f.clinicId,
      signerConfig: {
        mode: "sequential",
        signers: [{ role_key: "patient", required: true, order: 0 }],
      },
      patient: {
        id: f.minorId,
        full_name: "ليان أحمد",
        phone_e164: "+962790000003",
        birth_date: DateTime.now().minus({ years: 9 }).toISODate(),
      },
    });
    // Staff supply the guardian's details, as the UI requires.
    const withGuardian = signers.map((s) =>
      s.roleKey === "guardian"
        ? { ...s, displayName: "سعاد أحمد", phone: "+962790000088", relationship: "الأم" }
        : s
    );
    const documentId = await createDocument(c, {
      clinicId: f.clinicId,
      userId: f.ownerId,
      patientId: f.minorId,
      templateId: f.noPhoneTemplateId,
      title: "موافقة ولي الأمر",
      language: "ar",
      signers: withGuardian,
    });
    await sendDocument(c, { clinicId: f.clinicId, documentId, userId: f.ownerId });

    const rows = await loadSigners(c, documentId, f.clinicId);
    for (const s of rows) {
      await recordSignature(c, {
        clinicId: f.clinicId,
        documentId,
        signerId: s.id,
        input: { pngDataUrl: PNG_1PX, consentConfirmed: true },
        ip: "203.0.113.30",
        userAgent: "Mozilla/5.0 (Android 14) Chrome/120 Mobile Safari/537.36",
      });
    }
    const status = (await c.query(`select status from documents where id = $1`, [documentId])).rows[0]
      .status;
    return { documentId, rows, status };
  });

  check(
    built.rows.some((s) => s.role_key === "guardian" && s.relationship === "الأم"),
    "the guardian's relationship to the patient is stored"
  );
  check(built.status === "completed", "the document completes once patient and guardian sign", built.status);

  const { loadPrintDocument } = await import("../src/lib/esign/print-data");
  const printed = await loadPrintDocument(built.documentId);
  check(!!printed, "the certificate data loads for a guardian document");
  if (!printed) return;
  check(
    printed.signers.length === 2,
    "both the patient and the guardian appear on the certificate",
    printed.signers.length
  );
  check(
    printed.signers.every((s) => !!s.signatureDataUrl),
    "both signatures are embedded, not just named"
  );
  const guardian = printed.signers.find((s) => s.roleKey === "guardian");
  check(guardian?.relationship === "الأم", "the certificate names the guardian's relationship");
  check(
    !!guardian?.signedAtUtc && !!guardian?.signedAtLocal,
    "the guardian's signature is timed in both UTC and clinic time"
  );
}

async function cleanup(f: Fixture) {
  await sys(async (c) => {
    await c.query(`delete from clinics where slug like 'qa-esign-%' or slug like 'qa-other-%'`);
  });
  ok("test fixtures cleaned up");
}

async function main() {
  console.log("── document signing QA ──\n");
  const f = await setup();
  ok(`fixture clinic ${f.slug}`);

  const firstDoc = await testMergeAndFreeze(f);
  await testTokenLifecycle(f, firstDoc);
  const completed = await testSequentialSigning(f);
  await testHashMismatchRefusal(f);
  await testAppendOnlyAudit(f);
  await testGuardianAndEdgeCases(f);
  await testLockingAndResume(f);
  await testDeclineAndView(f);
  await testAppointmentIntegration(f);
  await testDetailReadModel(f, completed);
  await testRls(f);
  await testPdf(f, completed);
  const uploaded = await testUploadedPdfPath(f);
  await testSignedCopyDelivery(f, completed);
  await testSendAllPending(f);
  await testGuardianOnCertificate(f);
  void uploaded;
  await cleanup(f);

  console.log("\n" + "─".repeat(56));
  if (failures.length) {
    console.log(`  FAILED — ${passed} passed, ${failures.length} failed`);
    for (const x of failures) console.log(`    · ${x}`);
  } else {
    console.log(`  PASSED — ${passed} assertions`);
  }
  console.log("─".repeat(56));
  await pool.end();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("\nfatal:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
