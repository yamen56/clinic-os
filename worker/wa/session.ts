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
    for (const row of staff.rows) {
      await c.query(
        `insert into notifications (clinic_id, user_id, kind, title, body, url)
         values ($1, $2, 'whatsapp_disconnected', $3, $4, $5)`,
        [
          clinicId,
          row.user_id ?? row.id,
          `انقطع اتصال واتساب — ${clinic.name_ar || clinic.name}`,
          "الأتمتة والرسائل متوقفة حتى إعادة الربط.",
          `/c/${clinic.slug}/settings/whatsapp`,
        ]
      );
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
