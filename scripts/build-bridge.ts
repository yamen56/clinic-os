/**
 * Builds ClinictiBridge.exe — one file a doctor downloads and double-clicks.
 *
 *   npx tsx scripts/build-bridge.ts [--server https://app.clinicti.app]
 *
 * 1. esbuild bundles bridge/src (and the DICOM networking library) into one
 *    CommonJS file, with the Clinicti address baked in.
 * 2. Node's single-executable-application support turns that file into a
 *    blob, which postject injects into a copy of this machine's node.exe.
 *    rcedit first gives the copy Clinicti's icon and name, so Task Manager
 *    and the file's properties say what it is.
 *
 * Windows only (it needs a Windows node.exe), and unsigned: Windows shows
 * "Windows protected your PC" the first time, and the setup screen says to
 * press More info → Run anyway. Output: dist-bridge/ClinictiBridge.exe.
 * Publish it with scripts/publish-bridge.ts.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { BRIDGE_VERSION } from "../src/lib/imaging/bridge-version";

const args = process.argv.slice(2);
const server = args.includes("--server") ? args[args.indexOf("--server") + 1] : "https://app.clinicti.app";
const out = path.join(process.cwd(), "dist-bridge");
const exe = path.join(out, "ClinictiBridge.exe");

/** An .ico holding one 256px PNG — Windows Vista onward reads PNG-in-ICO. */
async function icon(): Promise<string> {
  const png = await sharp(path.join(process.cwd(), "public", "icons", "icon-512.png")).resize(256, 256).png().toBuffer();
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt8(0, 6); // 256 wide
  head.writeUInt8(0, 7); // 256 high
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bpp
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  const file = path.join(out, "clinicti.ico");
  fs.writeFileSync(file, Buffer.concat([head, png]));
  return file;
}

async function main() {
  if (process.platform !== "win32") throw new Error("Build the Bridge on Windows: it embeds a Windows node.exe.");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const bundle = path.join(out, "bridge.cjs");
  await build({
    entryPoints: ["bridge/src/main.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: bundle,
    minify: true,
    legalComments: "none",
    define: { __CLINICTI_SERVER__: JSON.stringify(server) },
    logLevel: "warning",
  });
  console.log(`bundled ${(fs.statSync(bundle).size / 1024).toFixed(0)} KB for ${server}`);

  const seaConfig = path.join(out, "sea-config.json");
  fs.writeFileSync(
    seaConfig,
    JSON.stringify({ main: bundle, output: path.join(out, "sea-prep.blob"), disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false })
  );
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

  fs.copyFileSync(process.execPath, exe);
  const rcedit = path.join(process.cwd(), "node_modules", "rcedit", "bin", "rcedit-x64.exe");
  execFileSync(rcedit, [
    exe,
    "--set-icon", await icon(),
    "--set-version-string", "ProductName", "Clinicti Bridge",
    "--set-version-string", "FileDescription", "Clinicti Bridge — connects imaging machines to Clinicti",
    "--set-version-string", "CompanyName", "Clinicti",
    "--set-version-string", "OriginalFilename", "ClinictiBridge.exe",
    "--set-version-string", "InternalName", "ClinictiBridge",
    "--set-file-version", BRIDGE_VERSION,
    "--set-product-version", BRIDGE_VERSION,
  ]);
  execFileSync(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "postject", "dist", "cli.js"),
      exe,
      "NODE_SEA_BLOB",
      path.join(out, "sea-prep.blob"),
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { stdio: "inherit" }
  );
  console.log(`built ${exe} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB), version ${BRIDGE_VERSION}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
