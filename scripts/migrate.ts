import { ensureDatabase, runMigrations } from "./lib-migrate";

ensureDatabase()
  .then(runMigrations)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
