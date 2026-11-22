import type { PoolClient } from "pg";
import { readFileBuffer } from "../storage";
import { recordSignature } from "./signing";
import type { DocumentRow, SignerRow } from "./documents";

/**
 * Staff signatures applied by the staff member's own standing instruction.
 *
 * Yamen, 2026-11-21: "the doctor should be notified to sign, or he can be
 * signed automatically, because mostly there is no need for him to sign every
 * time". So a doctor (or any staff signer) may switch on "sign for me
 * automatically" on their own signature page; from then on, a document that
 * needs their signature has their saved signature applied the moment it goes
 * out, and they are not asked.
 *
 * What makes that defensible rather than a forgery:
 *  - only the member can switch it on, for themselves, in one clinic;
 *  - it applies the signature they drew and saved, never anyone else's;
 *  - the signature is recorded as automatic — on the signer row, on the
 *    `signed` event and on the certificate — so nobody reading the document
 *    later mistakes it for a tap.
 *
 * A template that asks this signer a question cannot be answered by a robot,
 * so recordSignature refuses (missing_fields) and the signer is simply asked
 * as before. Anything else that goes wrong also leaves them to be asked.
 */
export async function autoSignStaff(
  c: PoolClient,
  args: { clinicId: string; doc: Pick<DocumentRow, "id">; due: SignerRow[] }
): Promise<{ signed: Set<string>; completed: boolean }> {
  const signed = new Set<string>();
  let completed = false;
  const staff = args.due.filter((s) => s.user_id && s.status !== "signed" && s.status !== "declined");
  if (!staff.length) return { signed, completed };

  const opted = await c.query(
    `select cm.user_id, u.signature_png_path
       from clinic_members cm join users u on u.id = cm.user_id
      where cm.clinic_id = $1 and cm.active and cm.auto_sign_documents
        and u.signature_png_path is not null
        and cm.user_id = any($2::uuid[])`,
    [args.clinicId, staff.map((s) => s.user_id)]
  );
  const saved = new Map<string, string>(opted.rows.map((r) => [r.user_id as string, r.signature_png_path as string]));

  for (const s of staff) {
    const path = saved.get(s.user_id!);
    if (!path) continue;
    const buf = await readFileBuffer(path);
    if (!buf) continue;
    const r = await recordSignature(c, {
      clinicId: args.clinicId,
      documentId: args.doc.id,
      signerId: s.id,
      input: { pngDataUrl: `data:image/png;base64,${buf.toString("base64")}`, consentConfirmed: true, fieldAnswers: {} },
      actorUserId: s.user_id,
      automatic: true,
    });
    if (!r.ok) continue;
    signed.add(s.id);
    if (r.completed) completed = true;
  }
  return { signed, completed };
}
