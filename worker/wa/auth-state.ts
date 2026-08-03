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
    return withSystem(async (c) => {
      const r = await c.query(
        `select value from whatsapp_auth_state where clinic_id = $1 and key = $2`,
        [clinicId, key]
      );
      if (!r.rowCount) return null;
      return JSON.parse(JSON.stringify(r.rows[0].value), BufferJSON.reviver);
    });
  };
  const write = async (key: string, value: unknown): Promise<void> => {
    const json = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    await withSystem((c) =>
      c.query(
        `insert into whatsapp_auth_state (clinic_id, key, value) values ($1, $2, $3)
         on conflict (clinic_id, key) do update set value = excluded.value, updated_at = now()`,
        [clinicId, key, JSON.stringify(json)]
      )
    );
  };
  const remove = async (key: string): Promise<void> => {
    await withSystem((c) =>
      c.query(`delete from whatsapp_auth_state where clinic_id = $1 and key = $2`, [clinicId, key])
    );
  };

  const creds = ((await read("creds")) as ReturnType<typeof initAuthCreds>) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = (await read(`${type}:${id}`)) as SignalDataTypeMap[T] | null;
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
        for (const [type, byId] of Object.entries(data)) {
          for (const [id, value] of Object.entries(byId ?? {})) {
            const key = `${type}:${id}`;
            if (value) await write(key, value);
            else await remove(key);
          }
        }
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
