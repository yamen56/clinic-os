import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { withCtx, withSystem } from "@/lib/db";
import { rateLimitShared } from "@/lib/rate-limit-shared";

/**
 * A clinic's machines, and how they prove who they are.
 *
 * A device has no user and no session: it holds a key the clinic made for it
 * in Settings → Devices, sent on every call as `Authorization: Bearer <key>`
 * or as the password of HTTP Basic (which is what DICOM relays such as
 * Orthanc can be configured with). The key decides the clinic, so nothing a
 * device sends can name another one; inside, it works in that clinic's RLS
 * context with no user at all.
 */

// The machine types live with the file kinds (client-safe); re-exported for the server code here.
import { DEVICE_KINDS, type DeviceKind } from "./kinds";
export { DEVICE_KINDS, type DeviceKind };

/**
 * What the machine's "Patient ID" means. A machine whose software keeps its
 * own patient numbers would otherwise file patient 123 of *its* list into
 * Clinicti's file number 123 — somebody else — so trusting it is something the
 * clinic switches on, per device, once it has set the machine up that way.
 */
export const MATCH_BY = ["none", "clinicti", "national_id"] as const;
export type MatchBy = (typeof MATCH_BY)[number];

export type Device = {
  id: string;
  clinicId: string;
  clinicName: string;
  slug: string;
  timezone: string;
  name: string;
  kind: DeviceKind;
  matchBy: MatchBy;
};

const KEY_PREFIX = "ctd_";

export function newDeviceKey(): { key: string; hash: string; hint: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, hash: hashDeviceKey(key), hint: key.slice(-4) };
}

export function hashDeviceKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/*
  Pairing: what the doctor types into the Clinicti Bridge instead of a key.
  Six characters from an alphabet with nothing that reads as something else
  (no O/0, I/1/L), shown as "K7P-4QX". Hashed like the key, good for fifteen
  minutes, used once — and the pair endpoint is rate-limited per address, so
  887 million codes against twenty guesses a quarter-hour is not a door.
*/
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIR_MINUTES = 15;

export function newPairCode(): { code: string; hash: string } {
  const bytes = randomBytes(6);
  let code = "";
  for (const b of bytes) code += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  return { code, hash: hashPairCode(code) };
}

/** What a person typed, as the code it means: case, spaces and dashes forgiven. */
export function normalizePairCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashPairCode(code: string): string {
  return createHash("sha256").update(`pair:${normalizePairCode(code)}`).digest("hex");
}

/** "K7P4QX" → "K7P-4QX", the way it is shown and read aloud. */
export function formatPairCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** The key from `Bearer <key>`, or from Basic auth's password (or user, if that is all there is). */
export function keyFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(h);
  if (bearer) return bearer[1];
  const basic = /^Basic\s+(\S+)$/i.exec(h);
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const user = i < 0 ? decoded : decoded.slice(0, i);
    const pass = i < 0 ? "" : decoded.slice(i + 1);
    return (pass || user).trim() || null;
  }
  return req.headers.get("x-device-key")?.trim() || null;
}

function deny(status: number, error: string) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        // So a relay that tried without credentials knows to send them.
        ...(status === 401 ? { "WWW-Authenticate": 'Basic realm="Clinicti devices", charset="UTF-8"' } : {}),
      },
    }
  );
}

/** Uploads a minute per device: a CBCT series, one file per slice, with room to spare. */
const PER_MINUTE = 900;

export async function deviceAuth(
  req: Request
): Promise<{ ok: true; device: Device } | { ok: false; res: NextResponse }> {
  const key = keyFrom(req);
  if (!key || !key.startsWith(KEY_PREFIX) || key.length > 200) return { ok: false, res: deny(401, "device_key_required") };

  const row = await withSystem(async (c) => {
    const r = await c.query(
      `select d.id, d.clinic_id, d.name, d.kind, d.match_by, d.revoked_at,
              cl.name as clinic_name, cl.slug, cl.timezone, cl.deleted_at, cl.subscription_status
         from clinic_devices d join clinics cl on cl.id = d.clinic_id
        where d.key_hash = $1`,
      [hashDeviceKey(key)]
    );
    const d = r.rows[0];
    if (d && !d.revoked_at) {
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
      await c.query(`update clinic_devices set last_seen_at = now(), last_ip = $2 where id = $1`, [d.id, ip]);
    }
    return d;
  });
  if (!row || row.revoked_at) return { ok: false, res: deny(401, "device_key_invalid") };
  if (row.deleted_at) return { ok: false, res: deny(403, "deleted") };
  if (row.subscription_status === "suspended") return { ok: false, res: deny(402, "suspended") };
  if (!(await rateLimitShared(`device:${row.id}`, PER_MINUTE, 60_000))) {
    return { ok: false, res: NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } }) };
  }
  return {
    ok: true,
    device: {
      id: row.id,
      clinicId: row.clinic_id,
      clinicName: row.clinic_name,
      slug: row.slug,
      timezone: row.timezone,
      name: row.name,
      kind: row.kind,
      matchBy: row.match_by,
    },
  };
}

/** The device's clinic, as RLS sees it — no user, no admin. */
export function inDeviceClinic<T>(device: Device, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withCtx({ clinicId: device.clinicId }, fn);
}

/** The columns the settings screen shows for a device, after any change to one. */
export const DEVICE_RETURNING = `returning id, name, kind, match_by, method, key_hint, created_at, last_seen_at, images_received, revoked_at, paired_at, pair_expires_at, bridge`;
