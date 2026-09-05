/**
 * Does everything the worker imports actually exist inside the worker's image?
 *
 * On 2026-09-05 it did not, and the worker crash-looped in production for a day
 * with every clinic's WhatsApp socket in it. The chain was three links long and
 * every link was reasonable on its own:
 *
 *   worker/scheduler.ts  →  src/lib/ops-alert.ts   (platform alerts, new)
 *   src/lib/ops-alert.ts →  src/lib/email.ts       (to send them)
 *   src/lib/email.ts     →  src/emails/render.ts   (a re-export, never called here)
 *
 * `Dockerfile.worker` copies `src/lib` and not `src/emails`, so the third link
 * resolved locally — where the whole repository is on disk — and threw
 * MODULE_NOT_FOUND in the container. Nothing in the test suite could see it,
 * because every test runs against the repository rather than the image.
 *
 * This is the same shape as the bug that hid the broken backup for five weeks:
 * a runtime dependency of the worker that is not present where the worker runs.
 * `qa-backup.ts` closed the npm half of it — nothing the worker imports may be a
 * devDependency, because the image installs with `--omit=dev`. This closes the
 * file half: nothing the worker imports may live outside the paths the
 * Dockerfile copies.
 *
 * Static, so it costs a second and needs no Docker daemon. It walks the real
 * import graph from the real entry points in the real CMD.
 *
 *   npx tsx scripts/qa-worker-image.ts
 */
import fs from "node:fs";
import path from "node:path";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const norm = (p: string) => p.split(path.sep).join("/");

/** The source paths `Dockerfile.worker` copies into the image. */
function copiedPaths(dockerfile: string): string[] {
  const out: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!m) continue;
    // `COPY a b ./dest` — every argument but the last is a source.
    const parts = m[1].trim().split(/\s+/);
    if (parts.length < 2) continue;
    for (const src of parts.slice(0, -1)) {
      if (src.startsWith("--")) continue; // --from=, --chown=
      out.push(norm(src.replace(/^\.\//, "")));
    }
  }
  return out;
}

/** True when `file` sits under one of the copied paths. */
function isCopied(file: string, copied: string[]): boolean {
  const f = norm(file);
  return copied.some((c) => {
    if (c === f) return true;
    if (f.startsWith(c.endsWith("/") ? c : `${c}/`)) return true;
    // package*.json and tsconfig*.json
    if (c.includes("*")) {
      const rx = new RegExp(`^${c.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);
      return rx.test(f);
    }
    return false;
  });
}

/** Resolves a specifier the way tsx does, to a file in the repo, or null. */
function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join("src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.join(path.dirname(fromFile), spec);
  else return null; // a package; qa-backup.ts covers those

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return norm(c);
  }
  return null;
}

/**
 * Repo-relative paths a file opens at **runtime** rather than importing.
 *
 * The import graph is not the whole dependency graph. `src/emails/render.ts`
 * reads its templates with
 * `readFileSync(join(process.cwd(), "src/emails/templates", …))` — no import,
 * so the walk above cannot see it. Copying `render.ts` without its templates
 * would load perfectly and then throw the first time an email was sent, which
 * is a worse version of the bug this file exists to prevent: later, and only
 * under load.
 *
 * A literal beginning with one of the repo's own top-level directories is
 * treated as a path requirement. Over-matching is safe here — a false positive
 * names a directory that is almost certainly copied already — and under-matching
 * is what costs an outage.
 */
function runtimePathsIn(src: string): string[] {
  const out: string[] = [];
  const rx = /["'`]((?:src|worker|migrations|scripts|public)\/[A-Za-z0-9._/-]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src))) out.push(m[1]);
  return out;
}

/** Every `import`/`export ... from` and `await import()` specifier in a file. */
function specifiersIn(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const rx of patterns) {
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src))) out.push(m[1]);
  }
  return out;
}

function main() {
  const dockerfile = fs.readFileSync("Dockerfile.worker", "utf8");
  const copied = copiedPaths(dockerfile);
  check("the Dockerfile lists what it copies", copied.length >= 4, copied.join(" "));

  /*
    The entry points come out of the CMD rather than being hard-coded, so a
    change to how the container starts cannot leave this checking the wrong
    thing.
  */
  const cmd = /CMD\s+\[([\s\S]*?)\]/.exec(dockerfile)?.[1] ?? "";
  const entries = [...cmd.matchAll(/([\w./-]+\.ts)/g)].map((m) => m[1]);
  check("entry points were read from the CMD", entries.length >= 1, entries.join(", "));

  const seen = new Set<string>();
  const missing: { file: string; spec: string; from: string }[] = [];
  const queue = [...entries];

  while (queue.length) {
    const file = norm(queue.shift()!);
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);

    if (!isCopied(file, copied)) {
      missing.push({ file, spec: "(itself)", from: "entry" });
      continue;
    }
    const src = fs.readFileSync(file, "utf8");
    for (const spec of specifiersIn(src)) {
      const target = resolveLocal(file, spec);
      if (!target) continue;
      if (!isCopied(target, copied)) missing.push({ file: target, spec, from: file });
      queue.push(target);
    }
    // Files opened by path at runtime, which no import graph can reveal.
    for (const p of runtimePathsIn(src)) {
      if (!fs.existsSync(p)) continue; // not a real path — a message, a URL fragment
      if (!isCopied(p, copied)) missing.push({ file: p, spec: `runtime path "${p}"`, from: file });
    }
  }

  check("the graph was walked", seen.size > 10, `${seen.size} files`);
  /*
    The assertion. Every local file the worker can reach at runtime has to be
    inside the image, or the container throws MODULE_NOT_FOUND on boot and
    Railway restarts it forever.
  */
  check(
    "every file the worker imports is in its image",
    missing.length === 0,
    missing.length
      ? missing.map((m) => `${m.file} (via "${m.spec}" from ${m.from})`).join("; ")
      : `${seen.size} files, all copied`
  );

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
