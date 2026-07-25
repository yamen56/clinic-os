import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { LanguageToggle } from "@/components/language-toggle";

export default async function LoginPage() {
  const s = await getSession();
  if (s) redirect("/");
  return (
    <main className="flex min-h-dvh flex-col bg-paper">
      <div className="flex justify-end p-4">
        <LanguageToggle />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <LoginForm />
      </div>
      <footer className="pb-6 text-center text-xs text-ink-400">Makan Scaling · Clinic OS</footer>
    </main>
  );
}
