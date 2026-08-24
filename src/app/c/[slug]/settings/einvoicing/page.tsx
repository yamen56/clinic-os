import { redirect } from "next/navigation";
import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { can } from "@/lib/auth";
import { loadEinvoiceSettingsView, missingFields, loadEinvoiceSettings } from "@/lib/einvoice/settings";
import { EinvoicingForm } from "./einvoicing-form";

export default async function EinvoicingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  // No capability of its own; the licence is the gate. A clinic that has not
  // bought it should not find the page by typing the URL either.
  if (!access.clinic.features.einvoicing) redirect(`/c/${slug}/settings`);

  const data = await inClinic(access, async (c) => {
    /*
      Two reads of the same row, and only one of them leaves this function. The
      view has `hasSecret` in place of the key; the full record is used solely to
      work out what is still missing, and is discarded here.
    */
    const view = await loadEinvoiceSettingsView(c, access.clinicId);
    const missing = missingFields(await loadEinvoiceSettings(c, access.clinicId));
    const stats = (
      await c.query(
        `select
           count(*) filter (where einvoice_status = 'submitted')::int as submitted,
           count(*) filter (where einvoice_status = 'pending')::int as pending,
           count(*) filter (where einvoice_status = 'failed')::int as failed
         from invoices where clinic_id = $1`,
        [access.clinicId]
      )
    ).rows[0];
    return { view, missing, stats };
  });

  return (
    <EinvoicingForm
      slug={slug}
      isOwner={can(access, "settings.clinic")}
      settings={JSON.parse(JSON.stringify(data.view))}
      missing={data.missing}
      stats={data.stats}
    />
  );
}
