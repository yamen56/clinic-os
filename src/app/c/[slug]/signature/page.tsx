import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { readFileBuffer } from "@/lib/storage";
import { PageHeader } from "@/components/ui/card";
import { Card, CardHeader } from "@/components/ui/card";
import { PhotoPicker } from "@/components/photo-picker";
import { dictForClinic } from "@/lib/i18n";
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
      `select signature_png_path, kiosk_pin_hash, avatar_path from users where id = $1`,
      [access.session.user.id]
    );
    return r.rows[0] as {
      signature_png_path: string | null;
      kiosk_pin_hash: string | null;
      avatar_path: string | null;
    };
  });

  // Inlined rather than served from a route: it is one small image belonging to
  // the person looking at it, and a route would be a second thing to authorise.
  let current: string | null = null;
  if (me?.signature_png_path) {
    const buf = await readFileBuffer(me.signature_png_path);
    if (buf) current = `data:image/png;base64,${buf.toString("base64")}`;
  }

  const t = await dictForClinic(access.clinic.vocabulary);

  return (
    <>
      <PageHeader title={t.mySignature.title} sub={t.mySignature.sub} />

      {/*
        Your own photo lives here rather than in staff settings, for the same
        reason the signature does: this page is reachable by every role, and
        staff settings is not. A doctor can set their own picture without
        needing an owner to do it for them.
      */}
      {access.memberId && (
        <Card className="mb-4">
          <CardHeader title={t.staff.photoTitle} sub={t.staff.photoHint} />
          <div className="px-5 py-4">
            <PhotoPicker
              slug={slug}
              memberId={access.memberId}
              name={access.session.user.fullName}
              hasPhoto={!!me?.avatar_path}
            />
          </div>
        </Card>
      )}
      <SignatureSettings
        slug={slug}
        currentSignature={current}
        hasPin={!!me?.kiosk_pin_hash}
        myName={access.session.user.fullName}
      />
    </>
  );
}
