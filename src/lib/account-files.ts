import { withSystem } from "./db";
import { readFileBuffer, saveUserFile } from "./storage";

/**
 * Before a clinic's folder is destroyed, moves out the files in it that belong
 * to people rather than to the clinic — saved signatures and photos uploaded
 * from that clinic before they lived under `_users/` (2026-11-27).
 *
 * Without this, purging one clinic broke the signature a doctor uses at every
 * other clinic they work at: one account, one `users.signature_png_path`,
 * pointing into a folder that no longer exists. Best effort per file — a file
 * that cannot be read is left to the purge, as it was going to be anyway.
 */
export async function rescueAccountFiles(clinicId: string): Promise<number> {
  if (!/^[0-9a-f-]{36}$/i.test(clinicId)) return 0;
  const prefix = `${clinicId}/`;
  const users = await withSystem(async (c) =>
    (
      await c.query(
        `select id, signature_png_path, signature_svg_path, avatar_path from users
          where starts_with(signature_png_path, $1) or starts_with(signature_svg_path, $1) or starts_with(avatar_path, $1)`,
        [prefix]
      )
    ).rows as { id: string; signature_png_path: string | null; signature_svg_path: string | null; avatar_path: string | null }[]
  );
  let moved = 0;
  for (const u of users) {
    for (const [col, folder] of [
      ["signature_png_path", "signatures"],
      ["signature_svg_path", "signatures"],
      ["avatar_path", "avatars"],
    ] as const) {
      const from = u[col];
      if (!from || !from.startsWith(prefix)) continue;
      try {
        const buf = await readFileBuffer(from);
        if (!buf) continue;
        const name = from.split("/").pop() ?? "file";
        const saved = await saveUserFile(u.id, folder, name, buf);
        await withSystem((c) => c.query(`update users set ${col} = $2 where id = $1 and ${col} = $3`, [u.id, saved.storagePath, from]));
        moved++;
      } catch (e) {
        console.error("[account-files] could not move", col, (e as Error).message);
      }
    }
  }
  return moved;
}
