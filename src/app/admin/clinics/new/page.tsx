import { guardAdmin } from "@/lib/guard";
import { getDict } from "@/lib/i18n";
import { PageHeader } from "@/components/ui/card";
import { NewClinicForm } from "./new-clinic-form";

export default async function NewClinicPage() {
  await guardAdmin();
  const t = await getDict();
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t.admin.newClinic} />
      <NewClinicForm />
    </div>
  );
}
