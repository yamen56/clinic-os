import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { LanguageToggle } from "@/components/language-toggle";
import { BrandMark } from "@/components/brand-mark";

/**
 * Auth is the one working-adjacent screen on the night surface — the brand
 * moment before the daylight-white product takes over.
 */
export default async function LoginPage() {
  const s = await getSession();
  if (s) redirect("/");
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
        <LoginForm />
      </div>
      <footer className="pb-6 text-center text-xs text-white/40">Makan Scaling · Clinic OS</footer>
    </main>
  );
}
