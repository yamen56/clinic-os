import Link from "next/link";
import { guardAdmin } from "@/lib/guard";
import { getDict } from "@/lib/i18n";
import { LanguageToggle } from "@/components/language-toggle";
import { logoutAction } from "@/app/login/actions";
import { BrandPlate } from "@/components/brand-mark";
import { AdminNav } from "./admin-nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const s = await guardAdmin();
  const t = await getDict();
  return (
    <div className="min-h-dvh bg-paper">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="flex items-center gap-2 font-semibold tracking-tight">
              <BrandPlate size={32} />
              {t.admin.title}
            </Link>
            <AdminNav caps={s.adminCaps} />
          </div>
          <div className="flex items-center gap-2">
            <LanguageToggle compact />
            <form action={logoutAction}>
              <button className="rounded-full px-3 py-1.5 text-[13px] text-ink-500 hover:bg-ink-900/5">
                {t.auth.signOut}
              </button>
            </form>
            <span className="hidden text-sm text-ink-500 sm:block">{s.user.fullName}</span>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
