import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { withSystem } from "../db";
import { useDbAuthState } from "./auth-state";
import { handleUpsert } from "./inbound";
import { handleReceipts } from "./receipts";
import { learnLidMapping, pairsFromContacts, resolvePendingLids } from "./lid-mapping";
import { notifyUser } from "../../src/lib/notify";

const logger = pino({ level: "silent" });

/**
 * One Baileys session per clinic. Sessions are fully isolated: any crash is
 * caught, recorded on whatsapp_sessions, and retried with backoff — one
 * clinic's failure never touches the others.
 */
export class WASession {
  sock: WASocket | null = null;
  private stopping = false;
  private retries = 0;
  private clearAuth: (() => Promise<void>) | null = null;

  constructor(public clinicId: string) {}

  private async setSession(patch: Record<string, unknown>) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const sets = cols.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await withSystem((c) =>
      c.query(`update whatsapp_sessions set ${sets}, updated_at = now() where clinic_id = $1`, [
        this.clinicId,
        ...cols.map((k) => patch[k]),
      ])
    );
  }

  async start(): Promise<void> {
    this.stopping = false;
    try {
      const { state, saveCreds, clear } = await useDbAuthState(this.clinicId);
      this.clearAuth = clear;
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as unknown as [number, number, number] }));

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ["Makan Clinic Platform", "Chrome", "1.0.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });
      this.sock = sock;

      sock.ev.on("creds.update", () => {
        saveCreds().catch((e) => console.error(`[wa ${this.clinicId}] saveCreds`, e.message));
      });

      sock.ev.on("connection.update", (u) => {
        void (async () => {
          try {
            if (u.qr) {
              await this.setSession({ status: "qr", qr: u.qr, error: null });
            }
            if (u.connection === "open") {
              this.retries = 0;
              const me = sock.user?.id ?? "";
              const phone = me.split(":")[0].split("@")[0];
              await this.setSession({
                status: "connected",
                qr: null,
                error: null,
                phone_number: phone ? `+${phone}` : null,
                display_name: sock.user?.name ?? null,
                connected_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                consecutive_errors: 0,
              });
              console.log(`[wa ${this.clinicId}] connected as +${phone}`);
              /*
                Now that there is a socket, ask what the identity-addressed
                threads are actually numbered. A short delay lets the library
                finish its own sync first, so the batch is answered from a warm
                mapping store rather than a cold one.
              */
              setTimeout(() => {
                resolvePendingLids(this.clinicId, sock)
                  .then((n) => n && console.log(`[wa ${this.clinicId}] resolved ${n} identity thread(s)`))
                  .catch((e) => console.error(`[wa ${this.clinicId}] lid sweep`, (e as Error).message));
              }, 20_000);
            }
            if (u.connection === "close") {
              const code =
                (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
                  ?.output?.statusCode ?? 0;
              if (code === DisconnectReason.loggedOut) {
                console.log(`[wa ${this.clinicId}] logged out`);
                await this.clearAuth?.();
                await this.setSession({
                  status: "logged_out",
                  qr: null,
                  desired: false,
                  error: "Logged out from the phone",
                });
                await notifyDisconnected(this.clinicId);
                return;
              }
              if (this.stopping) {
                await this.setSession({ status: "disconnected", qr: null });
                return;
              }
              // auto-reconnect with capped backoff
              this.retries++;
              const delay = Math.min(this.retries * 5, 60) * 1000;
              await this.setSession({
                status: "connecting",
                qr: null,
                error: `Reconnecting (attempt ${this.retries})`,
              });
              console.log(`[wa ${this.clinicId}] closed (code ${code}), retry in ${delay / 1000}s`);
              setTimeout(() => {
                if (!this.stopping) void this.start();
              }, delay);
              if (this.retries === 5) await notifyDisconnected(this.clinicId);
            }
          } catch (e) {
            console.error(`[wa ${this.clinicId}] connection.update`, (e as Error).message);
          }
        })();
      });

      sock.ev.on("messages.upsert", (m) => {
        handleUpsert(this.clinicId, sock, m).catch((e) =>
          console.error(`[wa ${this.clinicId}] inbound`, (e as Error).message)
        );
      });

      // Delivered and read arrive here, long after the send returned.
      sock.ev.on("messages.update", (u) => {
        handleReceipts(this.clinicId, u).catch((e) =>
          console.error(`[wa ${this.clinicId}] receipts`, (e as Error).message)
        );
      });

      /*
        The two places WhatsApp tells us which phone number is behind a LID.
        A LID-addressed thread works without this — it is how the message
        reached us — but the number is what ties it to a patient file.
      */
      // The library resolves phone↔LID itself now and announces each pairing it
      // learns, which is both earlier and more reliable than the contact sync.
      sock.ev.on("lid-mapping.update", (m) => {
        learnLidMapping(this.clinicId, [{ lid: m.lid, jid: m.pn }]).catch((e) =>
          console.error(`[wa ${this.clinicId}] lid mapping`, (e as Error).message)
        );
      });
      const onContacts = (cts: Parameters<typeof pairsFromContacts>[0]) => {
        const pairs = pairsFromContacts(cts);
        if (pairs.length)
          learnLidMapping(this.clinicId, pairs).catch((e) =>
            console.error(`[wa ${this.clinicId}] lid contacts`, (e as Error).message)
          );
      };
      sock.ev.on("contacts.upsert", onContacts);
      sock.ev.on("contacts.update", onContacts);
    } catch (e) {
      console.error(`[wa ${this.clinicId}] start failed`, (e as Error).message);
      await this.setSession({ status: "disconnected", error: (e as Error).message }).catch(() => {});
      if (!this.stopping) {
        this.retries++;
        setTimeout(() => void this.start(), Math.min(this.retries * 10, 120) * 1000);
      }
    }
  }

  async stop(opts: { logout?: boolean } = {}): Promise<void> {
    this.stopping = true;
    try {
      if (opts.logout && this.sock) {
        await this.sock.logout().catch(() => {});
        await this.clearAuth?.();
      }
      this.sock?.end(undefined);
    } catch {}
    this.sock = null;
    await this.setSession({
      status: "disconnected",
      qr: null,
      ...(opts.logout ? { desired: false, phone_number: null, connected_at: null } : {}),
    });
  }

  get connected(): boolean {
    return !!this.sock?.user;
  }
}

async function notifyDisconnected(clinicId: string) {
  await withSystem(async (c) => {
    const clinic = (
      await c.query(`select name, name_ar, slug from clinics where id = $1`, [clinicId])
    ).rows[0];
    if (!clinic) return;
    // clinic owner + agency admins — automations depend on this connection
    const staff = await c.query(
      `select user_id from clinic_members where clinic_id = $1 and is_owner and active
       union select id from users where is_super_admin`,
      [clinicId]
    );
    /*
      Once an hour, not once per drop. This is raised both when the phone logs
      us out and again after five failed reconnects, so a connection that flaps
      — a clinic's wifi in the evening — produced an alert every few minutes
      about a thing the owner had already been told and could not act on any
      faster.
    */
    const hour = new Date().toISOString().slice(0, 13);
    for (const row of staff.rows) {
      await notifyUser(c, (row.user_id ?? row.id) as string, {
        clinicId,
        kind: "whatsapp_disconnected",
        title: `انقطع اتصال واتساب — ${clinic.name_ar || clinic.name}`,
        body: "الأتمتة والرسائل متوقفة حتى إعادة الربط.",
        url: `/c/${clinic.slug}/settings/whatsapp`,
        dedupeKey: `wa_disconnected:${clinicId}:${hour}`,
      });
    }
  }).catch((e) => console.error("[wa] notifyDisconnected", e.message));
}

/** Session registry. */
export const sessions = new Map<string, WASession>();

export async function ensureSession(clinicId: string): Promise<WASession> {
  let s = sessions.get(clinicId);
  if (!s) {
    s = new WASession(clinicId);
    sessions.set(clinicId, s);
    await s.start();
  }
  return s;
}

export async function stopSession(clinicId: string, opts: { logout?: boolean } = {}) {
  const s = sessions.get(clinicId);
  if (s) {
    await s.stop(opts);
    sessions.delete(clinicId);
  } else if (opts.logout) {
    await withSystem(async (c) => {
      await c.query(`delete from whatsapp_auth_state where clinic_id = $1`, [clinicId]);
      await c.query(
        `update whatsapp_sessions set status = 'disconnected', qr = null, desired = false, phone_number = null where clinic_id = $1`,
        [clinicId]
      );
    });
  }
}
