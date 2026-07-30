import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { readFileBuffer } from "@/lib/storage";
import { PageHeader } from "@/components/ui/card";
import { getDict } from "@/lib/i18n";
import { SignatureSettings } from "./signature-client";

/**
 * A staff member's own signature and device PIN.
 *
 * Deliberately *not* under /settings. That layout redirects doctors to the
 * dashboard, and a doctor is exactly who needs a saved signature — they are the
 * countersigner on most consent forms. This is personal, not clinic
 * configuration, so it lives on its own route that every role can reach.
 */
export default async function SignatureSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);

  const me = await inClinic(access, async (c) => {
    const r = await c.query(
      `select signature_png_path, kiosk_pin_hash from users where id = $1`,
      [access.session.user.id]
    );
    return r.rows[0] as { signature_png_path: string | null; kiosk_pin_hash: string | null };
  });

  // Inlined rather than served from a route: it is one small image belonging to
  // the person looking at it, and a route would be a second thing to authorise.
  let current: string | null = null;
  if (me?.signature_png_path) {
    const buf = await readFileBuffer(me.signature_png_path);
    if (buf) current = `data:image/png;base64,${buf.toString("base64")}`;
  }

  const t = await getDict();

  return (
    <>
      <PageHeader title={t.mySignature.title} sub={t.mySignature.sub} />
      <SignatureSettings
        slug={slug}
        currentSignature={current}
        hasPin={!!me?.kiosk_pin_hash}
        myName={access.session.user.fullName}
      />
    </>
  );
}
