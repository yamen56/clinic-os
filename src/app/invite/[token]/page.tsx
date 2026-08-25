import { readAuthToken } from "@/lib/invites";
import { getDict } from "@/lib/i18n";
import { BrandMark } from "@/components/brand-mark";
import { SetPasswordForm } from "@/components/set-password-form";
import { CLINICTI_PRIVACY_URL, CLINICTI_TERMS_URL } from "@/components/powered-by";
import { acceptInviteAction } from "./actions";

/**
 * The sentence that makes activation an act of acceptance.
 *
 * This page is where a clinic owner or a member of staff first gets in, and
 * there is no other signup flow — the agency creates the workspace and sends
 * the invitation — so this button is the moment the subscription agreement
 * starts binding somebody. That belongs beside the button rather than filed in
 * a footer, and the terms are named rather than gestured at.
 */
function AcceptanceNote({
  t,
}: {
  t: { legal: string; terms: string; privacy: string };
}) {
  // Split on both tokens at once. Every dictionary puts {terms} before
  // {privacy}, so the three pieces always land in the same order.
  const [before, middle, after] = t.legal.split(/\{terms\}|\{privacy\}/);
  const link =
    "underline decoration-white/30 underline-offset-2 transition-colors hover:text-white/90";
  return (
    <p className="max-w-[420px] text-center text-xs leading-relaxed text-white/45">
      {before}
      <a href={CLINICTI_TERMS_URL} target="_blank" rel="noopener noreferrer" className={link}>
        {t.terms}
      </a>
      {middle}
      <a href={CLINICTI_PRIVACY_URL} target="_blank" rel="noopener noreferrer" className={link}>
        {t.privacy}
      </a>
      {after}
    </p>
  );
}

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
        <div className="flex w-full flex-col items-center gap-4">
          <SetPasswordForm
            token={token}
            action={acceptInviteAction}
            heading={t.invite.heading.replace("{clinic}", info.clinicName ?? "Clinicti")}
            sub={t.invite.sub.replace("{email}", info.email)}
            submitLabel={t.invite.submit}
          />
          <AcceptanceNote t={t.invite} />
        </div>
      ) : (
        <div className="w-full max-w-[420px] rounded-modal border border-line bg-surface p-6 text-center shadow-modal">
          <h1 className="font-display text-xl font-semibold text-ink-900">{t.invite.invalidTitle}</h1>
          <p className="mt-2 text-sm text-ink-500">{t.invite.invalidBody}</p>
        </div>
      )}
    </main>
  );
}
