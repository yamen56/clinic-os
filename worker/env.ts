/**
 * Loads .env before any other module reads process.env.
 *
 * Import this FIRST in the worker entrypoint. ES module imports are hoisted and
 * evaluated before the importing module's own statements, so a `loadEnvFile()`
 * call in index.ts would run *after* sibling modules had already captured their
 * config — silently falling back to defaults.
 */
try {
  process.loadEnvFile?.();
} catch {
  // No .env file — rely on real environment variables (production).
}

export {};
