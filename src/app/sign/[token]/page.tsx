import type { Metadata } from "next";
import { getLocale } from "@/lib/i18n";
import { loadSigningView } from "@/lib/esign/public";
import { SigningFlow } from "@/components/esign/signing-flow";
import { SigningDeadEnd } from "@/components/esign/signing-dead-end";

/**
 * The page a patient lands on from WhatsApp.
 *
 * No login, no code, no verification screen: the link is single use, scoped to
 * one signature, and was delivered into that patient's own WhatsApp thread on
 * the number the clinic already had on file. That delivery is the identity check.
 *
 * Every failure state here is a real screen with a working next action — an
 * expired link offers to ask for a new one, a revoked link says to check
 * WhatsApp. Nothing dead-ends.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PublicSignPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const view = await loadSigningView(token, { countAttempt: true });
  // The document's own language wins over the visitor's cookie: they are being
  // shown a specific document, in the language it was written in.
  const locale = view.document?.language ?? (await getLocale());

  if (view.state !== "ready" && view.state !== "needs_code") {
    return <SigningDeadEnd view={view} locale={locale} token={token} />;
  }

  return <SigningFlow mode="remote" token={token} view={view} locale={locale} />;
}
