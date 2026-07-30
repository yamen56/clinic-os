"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate } from "@/lib/dates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Toggle } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  copyLibraryTemplateAction,
  deleteSignerRoleAction,
  deleteTemplateAction,
  saveEsignSettingsAction,
  saveSignerRoleAction,
} from "./actions";
import {
  FileSignature,
  Plus,
  Trash2,
  Pencil,
  Library,
  Upload,
  Users,
  ShieldCheck,
} from "lucide-react";

type Template = {
  id: string;
  name: string;
  name_ar: string | null;
  category: string;
  language: string;
  source: string;
  version: number;
  is_active: boolean;
  updated_at: string;
  library_key: string | null;
  used: number;
  services: { id: string; name: string; nameAr: string | null }[];
};

type Role = {
  id: string;
  key: string;
  label: string;
  label_ar: string | null;
  is_staff: boolean;
  is_system: boolean;
};

export function DocumentSettingsClient({
  slug,
  isOwner,
  templates,
  roles,
  library,
  settings,
}: {
  slug: string;
  isOwner: boolean;
  templates: Template[];
  roles: Role[];
  library: { key: string; name: string; name_ar: string | null; category: string }[];
  settings: { linkDays: number; requireCode: boolean; reminderHours: number };
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [roleEdit, setRoleEdit] = useState<Partial<Role> | null>(null);
  const [roleDelete, setRoleDelete] = useState<Role | null>(null);
  const [tplDelete, setTplDelete] = useState<Template | null>(null);
  const [cfg, setCfg] = useState(settings);

  const name = (x: { name: string; name_ar: string | null }) =>
    locale === "ar" ? x.name_ar || x.name : x.name;

  const copy = (key: string) =>
    start(async () => {
      const r = await copyLibraryTemplateAction(slug, key);
      if (r.error) {
        toast(t.common.genericError, "error");
        return;
      }
      toast(t.docTemplates.copied);
      setLibraryOpen(false);
      router.refresh();
    });

  const saveSettings = () =>
    start(async () => {
      const r = await saveEsignSettingsAction(slug, cfg);
      toast(r.error ? t.common.genericError : t.common.saved, r.error ? "error" : "success");
      router.refresh();
    });

  return (
    <div className="grid gap-4">
      {/* -------------------------------------------------------- templates */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{t.docTemplates.title}</h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t.docTemplates.sub}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {library.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setLibraryOpen(true)}>
                <Library className="h-4 w-4" />
                {t.docTemplates.fromLibrary}
              </Button>
            )}
            <Link href={`/c/${slug}/settings/documents/new?source=upload`}>
              <Button variant="outline" size="sm">
                <Upload className="h-4 w-4" />
                {t.docTemplates.uploadTitle}
              </Button>
            </Link>
            <Link href={`/c/${slug}/settings/documents/new`}>
              <Button size="sm">
                <Plus className="h-4 w-4" />
                {t.docTemplates.addTemplate}
              </Button>
            </Link>
          </div>
        </div>

        {templates.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon={<FileSignature />}
              title={t.docTemplates.empty}
              body={t.docTemplates.emptyBody}
              action={
                library.length > 0 ? (
                  <Button onClick={() => setLibraryOpen(true)}>{t.docTemplates.fromLibrary}</Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center gap-3 px-5 py-3">
                <Link href={`/c/${slug}/settings/documents/${tpl.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium hover:text-brand-700">{name(tpl)}</span>
                    {!tpl.is_active && <Badge status="cancelled">{t.docTemplates.inactive}</Badge>}
                    {tpl.source === "upload" && (
                      <Badge status="neutral">
                        <Upload className="h-3 w-3" />
                        PDF
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-ink-400">
                    <span>
                      {(t.docTemplates.categories as Record<string, string>)[tpl.category] ??
                        tpl.category}
                    </span>
                    <span>{t.docTemplates.version.replace("{n}", String(tpl.version))}</span>
                    <span>{fmtDate(tpl.updated_at, "UTC", locale)}</span>
                    {tpl.services.length > 0 && (
                      <span className="text-brand-600">
                        {t.docTemplates.attachedServices}:{" "}
                        {tpl.services
                          .map((s) => (locale === "ar" ? s.nameAr || s.name : s.name))
                          .join(", ")}
                      </span>
                    )}
                  </div>
                </Link>
                <Link href={`/c/${slug}/settings/documents/${tpl.id}`}>
                  <Button variant="ghost" size="icon" aria-label={t.common.edit}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </Link>
                {isOwner && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.common.delete}
                    onClick={() => setTplDelete(tpl)}
                  >
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------------ signer roles */}
      <Card>
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
              <Users className="h-4 w-4 text-ink-400" />
              {t.signerRoles.title}
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-500">{t.signerRoles.sub}</p>
          </div>
          {isOwner && (
            <Button size="sm" variant="outline" onClick={() => setRoleEdit({ is_staff: false })}>
              <Plus className="h-4 w-4" />
              {t.signerRoles.addRole}
            </Button>
          )}
        </div>
        <ul className="divide-y divide-line">
          {roles.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {locale === "ar" ? r.label_ar || r.label : r.label}
                  </span>
                  {r.is_system && <Badge status="neutral">{t.signerRoles.builtIn}</Badge>}
                  {r.is_staff && <Badge status="brand">{t.signerRoles.isStaff}</Badge>}
                </div>
                <code className="mono text-[12px] text-ink-400" dir="ltr">
                  {r.key}
                </code>
              </div>
              {isOwner && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.common.edit}
                    onClick={() => setRoleEdit(r)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.common.delete}
                    disabled={r.is_system}
                    title={r.is_system ? t.signerRoles.cannotDelete : undefined}
                    onClick={() => setRoleDelete(r)}
                  >
                    <Trash2 className={`h-4 w-4 ${r.is_system ? "text-ink-300" : "text-danger"}`} />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {/* ---------------------------------------------------------- settings */}
      <Card>
        <div className="border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <ShieldCheck className="h-4 w-4 text-ink-400" />
            {t.esignSettings.title}
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-500">{t.esignSettings.sub}</p>
        </div>
        <div className="grid gap-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t.esignSettings.linkDays} hint={t.esignSettings.linkDaysHint}>
              <Input
                type="number"
                dir="ltr"
                min={1}
                max={90}
                disabled={!isOwner}
                value={cfg.linkDays}
                onChange={(e) => setCfg({ ...cfg, linkDays: Number(e.target.value) || 7 })}
              />
            </Field>
            <Field label={t.esignSettings.reminderHours} hint={t.esignSettings.reminderHoursHint}>
              <Input
                type="number"
                dir="ltr"
                min={1}
                max={336}
                disabled={!isOwner}
                value={cfg.reminderHours}
                onChange={(e) => setCfg({ ...cfg, reminderHours: Number(e.target.value) || 24 })}
              />
            </Field>
          </div>
          <label className="flex items-start justify-between gap-4 rounded-lg border border-line bg-subtle px-4 py-3">
            <span>
              <span className="block text-[13px] font-semibold">
                {t.esignSettings.requireCode}
              </span>
              <span className="mt-0.5 block max-w-xl text-[12px] leading-relaxed text-ink-500">
                {t.esignSettings.requireCodeHint}
              </span>
            </span>
            <Toggle
              checked={cfg.requireCode}
              disabled={!isOwner}
              label={t.esignSettings.requireCode}
              onChange={(v) => setCfg({ ...cfg, requireCode: v })}
            />
          </label>
          {isOwner && (
            <div className="flex justify-end">
              <Button onClick={saveSettings} loading={pending}>
                {t.common.save}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* ----------------------------------------------------------- modals */}
      <Modal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        title={t.docTemplates.fromLibrary}
      >
        <p className="mb-4 text-[13px] text-ink-500">{t.docTemplates.fromLibrarySub}</p>
        <div className="grid gap-2">
          {library.map((l) => (
            <div
              key={l.key}
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{locale === "ar" ? l.name_ar || l.name : l.name}</div>
                <div className="text-[12px] text-ink-400">
                  {(t.docTemplates.categories as Record<string, string>)[l.category] ?? l.category}
                </div>
              </div>
              <Button size="sm" variant="soft" loading={pending} onClick={() => copy(l.key)}>
                {t.docTemplates.copyFromLibrary}
              </Button>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={!!roleEdit}
        onClose={() => setRoleEdit(null)}
        title={roleEdit?.id ? t.common.edit : t.signerRoles.addRole}
      >
        {roleEdit && (
          <div className="grid gap-4">
            {!roleEdit.id && (
              <Field label={t.signerRoles.key} hint={t.signerRoles.keyHint} required>
                <Input
                  dir="ltr"
                  value={roleEdit.key ?? ""}
                  placeholder="lab_technician"
                  onChange={(e) =>
                    setRoleEdit({
                      ...roleEdit,
                      key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
                    })
                  }
                />
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.signerRoles.label} required>
                <Input
                  value={roleEdit.label ?? ""}
                  onChange={(e) => setRoleEdit({ ...roleEdit, label: e.target.value })}
                />
              </Field>
              <Field label={t.signerRoles.labelAr}>
                <Input
                  dir="rtl"
                  value={roleEdit.label_ar ?? ""}
                  onChange={(e) => setRoleEdit({ ...roleEdit, label_ar: e.target.value })}
                />
              </Field>
            </div>
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-[13px] font-medium">{t.signerRoles.isStaff}</span>
                <span className="block text-[12px] text-ink-500">{t.signerRoles.isStaffHint}</span>
              </span>
              <Toggle
                checked={!!roleEdit.is_staff}
                onChange={(v) => setRoleEdit({ ...roleEdit, is_staff: v })}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRoleEdit(null)}>
                {t.common.cancel}
              </Button>
              <Button
                loading={pending}
                disabled={!roleEdit.label?.trim() || (!roleEdit.id && !roleEdit.key)}
                onClick={() =>
                  start(async () => {
                    const r = await saveSignerRoleAction(slug, {
                      id: roleEdit.id,
                      key: roleEdit.key ?? "role",
                      label: roleEdit.label?.trim() ?? "",
                      labelAr: roleEdit.label_ar?.trim() ?? "",
                      isStaff: !!roleEdit.is_staff,
                    });
                    if (r.error) {
                      toast(t.common.genericError, "error");
                      return;
                    }
                    toast(t.common.saved);
                    setRoleEdit(null);
                    router.refresh();
                  })
                }
              >
                {t.common.save}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!roleDelete}
        onClose={() => setRoleDelete(null)}
        title={t.common.confirmDeleteTitle}
        body={t.common.confirmDeleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={() =>
          start(async () => {
            if (!roleDelete) return;
            const r = await deleteSignerRoleAction(slug, roleDelete.id);
            if (r.error) toast(t.signerRoles.cannotDelete, "error");
            setRoleDelete(null);
            router.refresh();
          })
        }
      />

      <ConfirmDialog
        open={!!tplDelete}
        onClose={() => setTplDelete(null)}
        title={t.docTemplates.deleteTemplate}
        body={t.docTemplates.deleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={() =>
          start(async () => {
            if (!tplDelete) return;
            const r = await deleteTemplateAction(slug, tplDelete.id);
            if (r.error) toast(t.common.genericError, "error");
            setTplDelete(null);
            router.refresh();
          })
        }
      />
    </div>
  );
}
