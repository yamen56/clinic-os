/**
 * Applies pending migrations and the agency defaults to the production database.
 *
 * Reads `.env.production.local` rather than taking a connection string on the
 * command line, so the Supabase password never lands in a shell history, a
 * process list or a log.
 *
 * Order matters: the agency recipes are seeded *before* the migrations run,
 * because migration 0012 backfills the document recipes into existing clinics by
 * reading `recipe_templates`. If that table has not been seeded yet, 0012 finds
 * nothing, inserts nothing, and is still marked as applied — the backfill would
 * be silently skipped with no way to notice.
 *
 *   npx tsx scripts/migrate-prod.ts            # apply
 *   npx tsx scripts/migrate-prod.ts --dry-run  # report what would happen
 */
import { Client } from "pg";
import { readdirSync } from "node:fs";
import { join } from "node:path";

process.loadEnvFile(".env.production.local");

const DRY = process.argv.includes("--dry-run");
const url = process.env.DATABASE_SUPER_URL;
if (!url) {
  console.error("DATABASE_SUPER_URL is not set in .env.production.local");
  process.exit(1);
}

function connect(): Client {
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

async function main() {
  console.log(`target: ${new URL(url!).host}`);
  console.log(DRY ? "mode:   dry run\n" : "mode:   APPLY\n");

  const probe = connect();
  await probe.connect();
  const applied = new Set(
    (await probe.query("select name from _migrations")).rows.map((r) => r.name as string)
  );
  const onDisk = readdirSync(join(process.cwd(), "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const pending = onDisk.filter((f) => !applied.has(f));

  console.log(`applied:  ${applied.size}`);
  console.log(`pending:  ${pending.length ? pending.join(", ") : "none"}`);

  // What the destructive-looking parts will actually touch.
  const before = {
    clinics: (await probe.query("select count(*)::int n from clinics")).rows[0].n,
    customFields: (await probe.query("select count(*)::int n from custom_field_defs")).rows[0].n,
    automations: (await probe.query("select count(*)::int n from automations")).rows[0].n,
  };
  console.log(
    `impact:   ${before.clinics} clinic(s), ${before.customFields} custom field(s) to migrate, ${before.automations} existing automation(s)\n`
  );
  await probe.end();

  if (DRY) {
    console.log("Nothing was changed.");
    return;
  }

  const { seedAgencyDefaults, ALL_RECIPES } = await import("./seed-recipes");
  const seed = async () => {
    const c = connect();
    await c.connect();
    try {
      await seedAgencyDefaults(c);
    } finally {
      await c.end();
    }
  };

  /*
    1. Agency defaults first — see the note at the top of this file.

    Allowed to fail, and only here. The seed writes whatever columns the current
    code knows about, so against a database that has not yet had this release's
    migrations it can be writing a column that does not exist yet. That is
    exactly the situation this pass exists for — it runs early only so that a
    migration which reads `recipe_templates` finds it populated — and a release
    that adds a recipe column must not be blocked by it. Pass three is the one
    that has to succeed.
  */
  try {
    await seed();
    console.log(`✓ seeded ${ALL_RECIPES.length} agency recipes`);
  } catch (e) {
    console.log(`… pre-migration seed deferred: ${(e as Error).message}`);
  }

  // 2. Migrations. `runMigrations` reads DATABASE_SUPER_URL from the environment,
  //    which this script has already loaded.
  const { runMigrations } = await import("./lib-migrate");
  await runMigrations();

  // 3. And again, now that the schema matches the code. This is the pass whose
  //    result is the one that ships.
  await seed();
  console.log(`✓ seeded ${ALL_RECIPES.length} agency recipes`);

  // 4. Report what actually changed, rather than assuming.
  const after = connect();
  await after.connect();
  const q = async (sql: string) => (await after.query(sql)).rows[0].n as number;
  console.log("\nafter:");
  console.log(`  field definitions:  ${await q("select count(*)::int n from patient_field_definitions")}`);
  console.log(`  signer roles:       ${await q("select count(*)::int n from signer_roles")}`);
  console.log(`  document templates: ${await q("select count(*)::int n from document_templates")}`);
  console.log(`  library forms:      ${await q("select count(*)::int n from document_template_library")}`);
  console.log(`  automations:        ${await q("select count(*)::int n from automations")}`);
  console.log(
    `  document recipes:   ${await q("select count(*)::int n from automations where recipe_key like 'document_%'")} (enabled by default)`
  );
  await after.end();
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
