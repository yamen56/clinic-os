"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { createDocumentAction } from "@/app/c/[slug]/documents/actions";
import { FileSignature, ChevronRight } from "lucide-react";

export type PickableTemplate = {
  id: string;
  name: string;
  name_ar: string | null;
  category: string;
  language: string;
};

/**
 * Template picker.
 *
 * Deliberately one step: pick a template and the document is created, already
 * merged, and staff land on it. The brief's budget is four taps from the patient
 * profile to a signable document, and a wizard cannot meet that — everything
 * that could be a question here is either already known from the patient record
 * or editable afterwards on the document itself.
 */
export function NewDocumentModal({
  open,
  onClose,
  slug,
  templates,
  patientId,
  appointmentId,
  serviceId,
  /** Where to go once the document exists. Defaults to its own page. */
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  templates: PickableTemplate[];
  patientId?: string | null;
  appointmentId?: string | null;
  serviceId?: string | null;
  onCreated?: (documentId: string) => void;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const pick = (templateId: string) =>
    start(async () => {
      setBusyId(templateId);
      const r = await createDocumentAction(slug, {
        templateId,
        patientId: patientId ?? null,
        appointmentId: appointmentId ?? null,
        serviceId: serviceId ?? null,
      });
      setBusyId(null);
      if (r.error || !r.id) {
        toast(
          (t.docs.errors as Record<string, string>)[r.error ?? ""] ?? t.common.genericError,
          "error"
        );
        return;
      }
      onClose();
      if (onCreated) onCreated(r.id);
      else router.push(`/c/${slug}/documents/${r.id}`);
    });

  const byCategory = templates.reduce<Record<string, PickableTemplate[]>>((acc, tpl) => {
    (acc[tpl.category] ??= []).push(tpl);
    return acc;
  }, {});

  return (
    <Modal open={open} onClose={onClose} title={t.docs.newDocument}>
      {templates.length === 0 ? (
        <EmptyState
          icon={<FileSignature />}
          title={t.docs.noTemplates}
          body={t.docs.noTemplatesBody}
          action={
            <Link href={`/c/${slug}/settings/documents`}>
              <Button>{t.docs.manageTemplates}</Button>
            </Link>
          }
        />
      ) : (
        <>
          <p className="mb-3 text-[13px] text-ink-500">{t.docs.chooseTemplateSub}</p>
          <div className="grid gap-3">
            {Object.entries(byCategory).map(([category, list]) => (
              <div key={category}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                  {(t.docTemplates.categories as Record<string, string>)[category] ?? category}
                </div>
                <div className="grid gap-1">
                  {list.map((tpl) => (
                    <button
                      key={tpl.id}
                      disabled={pending}
                      onClick={() => pick(tpl.id)}
                      className="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-start text-sm transition-colors hover:border-brand-400 hover:bg-brand-50/50 disabled:opacity-60"
                    >
                      <span className="flex-1 font-medium">
                        {locale === "ar" ? tpl.name_ar || tpl.name : tpl.name}
                      </span>
                      {busyId === tpl.id ? (
                        <span className="slim-progress w-10 rounded-full" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <Link
              href={`/c/${slug}/settings/documents`}
              className="text-[12px] font-medium text-brand-700 hover:underline"
            >
              {t.docs.manageTemplates}
            </Link>
          </div>
        </>
      )}
    </Modal>
  );
}
