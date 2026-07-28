import Link from "next/link";
import { readAuthToken } from "@/lib/invites";
import { getDict } from "@/lib/i18n";
import { BrandMark } from "@/components/brand-mark";
import { SetPasswordForm } from "@/components/set-password-form";
import { resetPasswordAction } from "./actions";

export default async function ResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const info = await readAuthToken(token, "reset");
  const t = await getDict();

  return (
    <main className="surface-night flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <BrandMark size={64} />
      {info ? (
        <SetPasswordForm
          token={token}
          action={resetPasswordAction}
          heading={t.auth.resetTitle}
          sub={t.auth.resetSub.replace("{email}", info.email)}
          submitLabel={t.auth.resetSubmit}
        />
      ) : (
        <div className="w-full max-w-[420px] rounded-modal border border-line bg-surface p-6 text-center shadow-modal">
          <h1 className="font-display text-xl font-semibold text-ink-900">{t.auth.resetExpiredTitle}</h1>
          <p className="mt-2 text-sm text-ink-500">{t.auth.resetExpiredBody}</p>
          <Link
            href="/forgot"
            className="mt-4 inline-block text-sm text-brand-700 underline underline-offset-4"
          >
            {t.auth.requestNewLink}
          </Link>
        </div>
      )}
    </main>
  );
}
