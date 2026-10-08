/**
 * Puts dist-bridge/ClinictiBridge.exe where "Download Clinicti Bridge" in
 * Settings → Devices serves it from.
 *
 *   npx tsx scripts/build-bridge.ts && npx tsx scripts/publish-bridge.ts          # local storage
 *   npx tsx scripts/build-bridge.ts && npx tsx scripts/publish-bridge.ts --prod   # the live bucket
 *
 * --prod reads .env.production.local for the object store, like migrate-prod.
 * Build for the live server (the default) before publishing to it: the
 * address the Bridge talks to is baked in at build time.
 */
import fs from "node:fs";
import path from "node:path";

async function main() {
  const prod = process.argv.includes("--prod");
  if (prod) process.loadEnvFile(".env.production.local");
  const exe = path.join(process.cwd(), "dist-bridge", "ClinictiBridge.exe");
  if (!fs.existsSync(exe)) throw new Error("Build it first: npx tsx scripts/build-bridge.ts");
  const bundle = fs.readFileSync(path.join(process.cwd(), "dist-bridge", "bridge.cjs"), "utf8");
  if (prod && !bundle.includes("https://app.clinicti.app")) throw new Error("This build talks to another server. Rebuild without --server before publishing to production.");

  // Imported after the env is loaded: storage decides its driver from it.
  const { saveSystemStream } = await import("../src/lib/storage");
  const { BRIDGE_STORAGE_PATH, BRIDGE_VERSION } = await import("../src/lib/imaging/bridge-version");
  const folder = path.posix.dirname(BRIDGE_STORAGE_PATH).replace(/^_system\//, "");
  const r = await saveSystemStream(folder, path.posix.basename(BRIDGE_STORAGE_PATH), fs.createReadStream(exe));
  if (r.storagePath !== BRIDGE_STORAGE_PATH) throw new Error(`stored at ${r.storagePath}, expected ${BRIDGE_STORAGE_PATH}`);
  console.log(`published Clinicti Bridge ${BRIDGE_VERSION} (${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB) to ${prod ? "the live bucket" : "local storage"}: ${r.storagePath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
