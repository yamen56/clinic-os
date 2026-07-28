import { readAuthToken } from "@/lib/invites";
import { getDict } from "@/lib/i18n";
import { BrandMark } from "@/components/brand-mark";
import { SetPasswordForm } from "@/components/set-password-form";
import { acceptInviteAction } from "./actions";

/**
 * Invitation acceptance. Public by design — the token is the credential, so the
 * visitor is signed out and there is nothing to authorise against yet.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const info = await readAuthToken(token, "invite");
  const t = await getDict();

  return (
    <main className="surface-night flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <BrandMark size={64} />
      {info ? (
        <SetPasswordForm
          token={token}
          action={acceptInviteAction}
          heading={t.invite.heading.replace("{clinic}", info.clinicName ?? "Clinic OS")}
          sub={t.invite.sub.replace("{email}", info.email)}
          submitLabel={t.invite.submit}
        />
      ) : (
        <div className="w-full max-w-[420px] rounded-modal border border-line bg-surface p-6 text-center shadow-modal">
          <h1 className="font-display text-xl font-semibold text-ink-900">{t.invite.invalidTitle}</h1>
          <p className="mt-2 text-sm text-ink-500">{t.invite.invalidBody}</p>
        </div>
      )}
    </main>
  );
}
