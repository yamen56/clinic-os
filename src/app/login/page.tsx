import { redirect } from "next/navigation";
import { getSession, landingPathFor, safeNextPath } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { LanguageToggle } from "@/components/language-toggle";
import { BrandMark } from "@/components/brand-mark";

/**
 * Auth is the one working-adjacent screen on the night surface — the brand
 * moment before the daylight-white product takes over.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  const s = await getSession();
  if (s) {
    redirect(
      next ??
        landingPathFor({
          isSuperAdmin: s.user.isSuperAdmin,
          clinicSlugs: s.memberships.map((m) => m.clinicSlug),
        })
    );
  }
  return (
    <main className="surface-night flex min-h-dvh flex-col">
      <div className="flex justify-end p-4">
        <LanguageToggle onDark />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
        <div className="flex flex-col items-center gap-4">
          <BrandMark size={72} />
          {/* The one place italic ships. Latin, so it keeps its own direction. */}
          <p
            dir="ltr"
            className="latin font-display text-lg font-bold italic tracking-[-0.005em] text-white/70"
          >
            Solutions Engineered for Success.
          </p>
        </div>
        <LoginForm next={next ?? undefined} />
      </div>
      <footer className="flex items-center justify-center gap-3 pb-6 text-center text-xs text-white/40">
        <span>Clinicti</span>
        <a
          href="https://privacy.clinicti.app"
          target="_blank"
          rel="noopener noreferrer"
          className="no-underline transition-colors hover:text-white/70"
        >
          Privacy
        </a>
      </footer>
    </main>
  );
}
