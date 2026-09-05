import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { withSystem } from "../db";

/**
 * Baileys auth state persisted per clinic in Postgres, so sessions survive
 * restarts without rescanning the QR.
 */
export async function useDbAuthState(clinicId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clear: () => Promise<void>;
}> {
  const read = async (key: string): Promise<unknown | null> => {
    const found = await readMany([key]);
    return found[key] ?? null;
  };

  /**
   * Many keys, one query.
   *
   * Baileys asks for keys in batches — every message decrypt fetches its
   * sender's session and identity together, and a resync asks for dozens at
   * once. Reading them one at a time meant one transaction per key: `begin`,
   * `set_config`, `select`, `commit`, four round trips, against a database on
   * the other side of the network. The batch is the same rows for a single
   * trip.
   */
  const readMany = async (keys: string[]): Promise<Record<string, unknown>> => {
    if (!keys.length) return {};
    return withSystem(async (c) => {
      const r = await c.query(
        `select key, value from whatsapp_auth_state where clinic_id = $1 and key = any($2::text[])`,
        [clinicId, keys]
      );
      const out: Record<string, unknown> = {};
      for (const row of r.rows) {
        out[row.key as string] = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
      }
      return out;
    });
  };

  /**
   * A whole `keys.set` batch as one transaction.
   *
   * This is the one that mattered. Pairing uploads on the order of eight
   * hundred pre-keys in a single call, and writing them one transaction at a
   * time is eight hundred sequential round trips with the socket waiting on
   * every one of them. On a worker holding sixty clinics, a restart made all of
   * them do it at once.
   *
   * Same rows in and out — an upsert over unnested arrays, plus one delete for
   * the keys Baileys asked to forget. The primary key `(clinic_id, key)` is
   * what makes the conflict target valid.
   */
  const writeBatch = async (
    upserts: { key: string; value: unknown }[],
    removals: string[]
  ): Promise<void> => {
    if (!upserts.length && !removals.length) return;
    await withSystem(async (c) => {
      if (upserts.length) {
        const ks = upserts.map((u) => u.key);
        const vs = upserts.map((u) =>
          JSON.stringify(JSON.parse(JSON.stringify(u.value, BufferJSON.replacer)))
        );
        await c.query(
          `insert into whatsapp_auth_state (clinic_id, key, value)
           select $1, k, v::jsonb from unnest($2::text[], $3::text[]) as t(k, v)
           on conflict (clinic_id, key)
             do update set value = excluded.value, updated_at = now()`,
          [clinicId, ks, vs]
        );
      }
      if (removals.length) {
        await c.query(
          `delete from whatsapp_auth_state where clinic_id = $1 and key = any($2::text[])`,
          [clinicId, removals]
        );
      }
    });
  };

  const write = async (key: string, value: unknown): Promise<void> => {
    await writeBatch([{ key, value }], []);
  };

  const creds = ((await read("creds")) as ReturnType<typeof initAuthCreds>) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        const found = await readMany(ids.map((id) => `${type}:${id}`));
        for (const id of ids) {
          let value = (found[`${type}:${id}`] ?? null) as SignalDataTypeMap[T] | null;
          if (type === "app-state-sync-key" && value) {
            // The stored shape is a plain object either way; the union this key
            // now widens to no longer satisfies `fromObject`'s parameter, so
            // the cast says what was already true rather than changing it.
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as unknown as { [k: string]: unknown }
            ) as unknown as SignalDataTypeMap[T];
          }
          if (value) out[id] = value;
        }
        return out;
      },
      set: async (data) => {
        const upserts: { key: string; value: unknown }[] = [];
        const removals: string[] = [];
        for (const [type, byId] of Object.entries(data)) {
          for (const [id, value] of Object.entries(byId ?? {})) {
            const key = `${type}:${id}`;
            if (value) upserts.push({ key, value });
            else removals.push(key);
          }
        }
        await writeBatch(upserts, removals);
      },
    },
  };

  return {
    state,
    saveCreds: () => write("creds", creds),
    clear: async () => {
      await withSystem((c) =>
        c.query(`delete from whatsapp_auth_state where clinic_id = $1`, [clinicId])
      );
    },
  };
}
