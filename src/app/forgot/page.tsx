import Link from "next/link";
import { getDict } from "@/lib/i18n";
import { BrandMark } from "@/components/brand-mark";
import { ForgotForm } from "./forgot-form";

export default async function ForgotPage() {
  const t = await getDict();
  return (
    <main className="surface-night flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <BrandMark size={64} />
      <ForgotForm />
      <Link href="/login" className="text-sm text-white/60 underline underline-offset-4 hover:text-white">
        {t.auth.backToSignIn}
      </Link>
    </main>
  );
}
