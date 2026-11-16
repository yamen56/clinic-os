import { redirect } from "next/navigation";
import { guardClinic } from "@/lib/guard";
import { financeViewer } from "@/lib/finance-access";
import { financeTabs } from "@/lib/finance";
import { FinanceFrame } from "./finance-nav";

/**
 * The clinic's money, in one section.
 *
 * A route group, so the folder says these pages belong together while every URL
 * stays exactly where it was. That is the whole reason for the parentheses:
 * moving them under `/finance/` would have meant rewriting nineteen
 * `revalidatePath` calls and fourteen test suites, and — the part no edit can
 * fix — breaking the `url` already stored on every notification the worker has
 * ever sent about an invoice.
 *
 * The door opens for any of the tabs and **each page still gates itself**.
 * That is not belt and braces: Next renders a layout and its page concurrently,
 * so a `redirect()` here does not stop the page below from having already run
 * its queries. This is the sidebar's own argument — `guardAdminAnyCap` exists
 * for the same shape on the agency side.
 *
 * There is deliberately no `loading.tsx` at this level any more: switching tabs
 * keeps the page there, faded, until the next one is whole (see FinanceFrame).
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
    /*
      A client component: it lights the pressed tab before the server has the
      next screen ready. It reads the path only — not `?tab=`, as the strip did
      when Payments was a tab of its own — so it needs no Suspense boundary.
    */
    <FinanceFrame slug={slug} tabs={tabs}>
      {children}
    </FinanceFrame>
  );
}
