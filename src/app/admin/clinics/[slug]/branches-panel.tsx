"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { addBranchAction } from "../../clinic-actions";
import { BRANCH_PARTS, type BranchPart } from "@/lib/branches-parts";
import { Plus } from "lucide-react";

export type BranchRow = { id: string; slug: string; name: string; status: string; current: boolean };
export type BranchStaff = { userId: string; name: string; role: string };

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 48);
}

/**
 * A clinic's branches, from the agency's side (Admin → clinic → Branches):
 * the workspaces in its group, and a form that opens another one with this
 * clinic's services, hours, forms and flows copied in (lib/branches).
 */
export function BranchesPanel({
  clinicId,
  clinicSlug,
  licensed,
  canAdd,
  branches,
  staff,
}: {
  clinicId: string;
  clinicSlug: string;
  licensed: boolean;
  canAdd: boolean;
  branches: BranchRow[];
  staff: BranchStaff[];
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [addressAr, setAddressAr] = useState("");
  const [price, setPrice] = useState("0");
  const [parts, setParts] = useState<BranchPart[]>([...BRANCH_PARTS]);
  const [people, setPeople] = useState<string[]>([]);
  const [bad, setBad] = useState<string | null>(null);
  const others = branches.filter((b) => !b.current);

  return (
    <Card>
      <CardHeader
        title={t.admin.tabBranches}
        sub={t.admin.branchesSub}
        action={
          licensed && canAdd && !open ? (
            <Button size="sm" onClick={() => setOpen(true)} data-add-branch>
              <Plus className="h-4 w-4" />
              {t.admin.addBranch}
            </Button>
          ) : undefined
        }
      />
      {!licensed && <p className="mx-5 mb-4 rounded-lg bg-sunken px-3 py-2 text-[0.8125rem] text-ink-700">{t.admin.branchesNotInPlan}</p>}
      <ul className="divide-y divide-line" data-branch-list>
        {branches.map((b) => (
          <li key={b.id} className="flex items-center gap-3 px-5 py-3" data-branch={b.slug}>
            <Avatar name={b.name} size={28} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink-900">{b.name}</div>
              <div className="text-[0.75rem] text-ink-500" dir="ltr">
                /{b.slug}
              </div>
            </div>
            {b.current ? (
              <Badge status="brand">{t.admin.thisClinic}</Badge>
            ) : (
              <Link href={`/admin/clinics/${b.slug}`} className="text-[0.8125rem] font-medium text-brand-700 hover:underline">
                {t.admin.tabOverview}
              </Link>
            )}
          </li>
        ))}
        {others.length === 0 && <li className="px-5 py-3 text-[0.8125rem] text-ink-500">{t.admin.noBranches}</li>}
      </ul>

      {open && (
        <form
          className="grid gap-4 border-t border-line px-5 py-5"
          data-branch-form
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await addBranchAction(clinicId, {
                name,
                nameAr,
                slug,
                phone,
                address,
                addressAr,
                planPrice: Number(price) || 0,
                copy: parts,
                staffUserIds: people,
              });
              if (r.error) {
                setBad(r.field ?? null);
                toast(r.error === "taken" ? "This slug is taken — choose another." : t.common.genericError, "error");
                return;
              }
              toast(t.admin.branchAdded);
              setOpen(false);
              router.push(`/admin/clinics/${r.slug}`);
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.admin.branchName} required>
              <Input
                value={name}
                autoFocus
                data-branch-name
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(`${clinicSlug}-${e.target.value}`));
                }}
              />
            </Field>
            <Field label={t.admin.branchNameAr}>
              <Input dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
            </Field>
            <Field label={t.admin.slug} required error={bad === "slug" ? t.common.genericError : undefined}>
              <Input
                dir="ltr"
                value={slug}
                data-branch-slug
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(slugify(e.target.value));
                }}
              />
            </Field>
            <Field label={t.common.phone} error={bad === "phone" ? t.common.genericError : undefined}>
              <Input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label={t.admin.address}>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} />
            </Field>
            <Field label={t.admin.addressAr}>
              <Input dir="rtl" value={addressAr} onChange={(e) => setAddressAr(e.target.value)} />
            </Field>
            <Field label={t.admin.planPrice}>
              <Input dir="ltr" type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink-900">{t.admin.copyFromMain}</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {BRANCH_PARTS.map((p) => (
                <label key={p} className="flex items-center gap-2 text-[0.8125rem] text-ink-700">
                  <input
                    type="checkbox"
                    checked={parts.includes(p)}
                    onChange={(e) => setParts((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))}
                    data-branch-part={p}
                  />
                  {t.admin.branchParts[p]}
                </label>
              ))}
            </div>
          </fieldset>
          {staff.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-ink-900">{t.admin.alsoWorksThere}</legend>
              <p className="mb-2 text-[0.75rem] text-ink-500">{t.admin.alsoWorksThereHint}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {staff.map((m) => (
                  <label key={m.userId} className="flex items-center gap-2 text-[0.8125rem] text-ink-700">
                    <input
                      type="checkbox"
                      checked={people.includes(m.userId)}
                      onChange={(e) => setPeople((x) => (e.target.checked ? [...x, m.userId] : x.filter((y) => y !== m.userId)))}
                    />
                    {m.name} · {t.staff.roles[m.role as "doctor" | "receptionist" | "other"] ?? m.role}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={pending} disabled={name.trim().length < 2 || slug.length < 2} data-create-branch>
              {t.admin.addBranch}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
