import { guardCap } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { InvoicingForm } from "./invoicing-form";
import { can } from "@/lib/auth";

export default async function InvoicingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardCap(slug, "settings");
  const clinic = await inClinic(access, async (c) => {
    const r = await c.query(
      `select invoice_prefix, invoice_counter, invoice_tax_rate, invoice_tax_label,
              invoice_footer, payment_instructions, currency
       from clinics where id = $1`,
      [access.clinicId]
    );
    return r.rows[0];
  });
  return (
    <InvoicingForm
      slug={slug}
      isOwner={can(access, "settings.clinic")}
      clinic={JSON.parse(JSON.stringify(clinic))}
    />
  );
}
