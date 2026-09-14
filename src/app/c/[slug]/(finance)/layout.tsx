import { Suspense } from "react";
import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { financeViewer } from "@/lib/finance-access";
import { financeTabs } from "@/lib/finance";
import { FinanceNav } from "./finance-nav";

/**
 * The clinic's money, in one section.
 *
 * A route group, so the folder says these three belong together while every URL
 * stays exactly where it was. That is the whole reason for the parentheses:
 * moving them under `/finance/` would have meant rewriting nineteen
 * `revalidatePath` calls and fourteen test suites, and — the part no edit can
 * fix — breaking the `url` already stored on every notification the worker has
 * ever sent about an invoice.
 *
 * The door opens for any of the three and **each page still gates itself**.
 * That is not belt and braces: Next renders a layout and its page concurrently,
 * so a `redirect()` here does not stop the page below from having already run
 * its queries. This is the sidebar's own argument — `guardAdminAnyCap` exists
 * for the same shape on the agency side.
 */
export default async function FinanceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  await guardClinic(slug);
  const viewer = await financeViewer(slug);
  const tabs = financeTabs(viewer);
  if (tabs.length === 0) redirect(`/c/${slug}`);

  return (
    <>
      {/*
        The strip reads `?tab=` to tell Invoices from Payments, which a layout is
        never handed — so it is a client component, and `useSearchParams` wants a
        boundary above it.
      */}
      <Suspense fallback={null}>
        <FinanceNav slug={slug} tabs={tabs} />
      </Suspense>
      {children}
    </>
  );
}
