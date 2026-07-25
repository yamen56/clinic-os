import { guardClinic } from "@/lib/guard";
import { inClinic } from "@/lib/clinic-api";
import { InvoicingForm } from "./invoicing-form";

export default async function InvoicingSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await guardClinic(slug);
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
      isOwner={access.role === "owner"}
      clinic={JSON.parse(JSON.stringify(clinic))}
    />
  );
}
