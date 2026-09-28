import { redirect } from "next/navigation";
import { getSession, landingPathFor, safeNextPath } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { LanguageToggle } from "@/components/language-toggle";
import { BrandMark } from "@/components/brand-mark";
import { googleConfigured } from "@/lib/google-oauth";
import { appleConfigured } from "@/lib/apple-oauth";

/**
 * Auth is the one working-adjacent screen on the night surface — the brand
 * moment before the daylight-white product takes over.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNextPath(sp.next);
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
        {/* A frosted plate under it: on a phone it sits over one of the light corner shapes. */}
        <div className="rounded-full bg-black/70 backdrop-blur-md">
          <LanguageToggle onDark />
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
        <BrandMark size={72} />
        <LoginForm
          next={next ?? undefined}
          google={googleConfigured()}
          apple={appleConfigured()}
          oauthError={sp.error}
        />
      </div>
      {/* On a dark plate, because on a phone the corner shapes reach under it. */}
      <footer className="mx-auto mb-6 flex w-fit items-center justify-center gap-3 rounded-full bg-black/75 px-3 py-1 text-center text-xs text-white/60 backdrop-blur-md">
        <a
          href="https://clinicti.app"
          className="no-underline transition-colors hover:text-white/70"
        >
          Clinicti
        </a>
        <a
          href="https://terms.clinicti.app"
          target="_blank"
          rel="noopener noreferrer"
          className="no-underline transition-colors hover:text-white/70"
        >
          Terms
        </a>
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
