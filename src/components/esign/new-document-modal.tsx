"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/client";
import { buttonClass } from "@/components/ui/button-class";
import { Modal } from "@/components/ui/modal";
import { EmptyState, Avatar } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { PatientPicker } from "@/components/appointments/patient-picker";
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
 * From a patient's file it is one step: pick a template and the document is
 * created, already merged, and staff land on it. From the Documents page it
 * first asks whose document it is — it used to skip that and create a
 * document about nobody, whose name, date of birth and every other patient
 * field were blank and blocked sending, which is the opposite of "pick and
 * send". A document that is genuinely about no patient is still one tap away.
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
  // Only asked when the caller did not already say whose document this is.
  const askPatient = !patientId;
  const [chosen, setChosen] = useState<{ id: string; name: string } | null>(null);
  const [noPatient, setNoPatient] = useState(false);
  const forPatient = patientId ?? chosen?.id ?? null;
  const ready = !askPatient || !!chosen || noPatient;

  const close = () => {
    setChosen(null);
    setNoPatient(false);
    onClose();
  };

  const pick = (templateId: string) =>
    start(async () => {
      setBusyId(templateId);
      const r = await createDocumentAction(slug, {
        templateId,
        patientId: forPatient,
        appointmentId: appointmentId ?? null,
        serviceId: serviceId ?? null,
      });
      setBusyId(null);
      if (r.error || !r.id) {
        toast((t.docs.errors as Record<string, string>)[r.error ?? ""] ?? t.common.genericError, "error");
        return;
      }
      close();
      if (onCreated) onCreated(r.id);
      else router.push(`/c/${slug}/documents/${r.id}`);
    });

  const byCategory = templates.reduce<Record<string, PickableTemplate[]>>((acc, tpl) => {
    (acc[tpl.category] ??= []).push(tpl);
    return acc;
  }, {});

  return (
    <Modal open={open} onClose={close} title={t.docs.newDocument}>
      {templates.length === 0 ? (
        <EmptyState
          icon={<FileSignature />}
          title={t.docs.noTemplates}
          body={t.docs.noTemplatesBody}
          action={
            <Link href={`/c/${slug}/settings/documents`} className={buttonClass()}>
              {t.docs.manageTemplates}
            </Link>
          }
        />
      ) : !ready ? (
        <div className="grid gap-3" data-pick-patient>
          <p className="text-[0.8125rem] font-semibold">{t.docs.whichPatient}</p>
          <PatientPicker slug={slug} autoFocus onPick={(p) => setChosen(p)} />
          <button type="button" onClick={() => setNoPatient(true)} className="justify-self-start text-[0.75rem] font-medium text-brand-700 hover:underline">
            {t.docs.noPatientDoc}
          </button>
        </div>
      ) : (
        <>
          {askPatient && (
            <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-line bg-subtle px-3 py-2" data-chosen-patient>
              {chosen ? <Avatar name={chosen.name} size={26} /> : <FileSignature className="h-4 w-4 text-ink-400" />}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{chosen ? chosen.name : t.docs.noPatientDoc}</span>
              <button
                type="button"
                onClick={() => {
                  setChosen(null);
                  setNoPatient(false);
                }}
                className="text-[0.75rem] font-medium text-brand-700 hover:underline"
              >
                {t.docs.changePatient}
              </button>
            </div>
          )}
          <p className="mb-3 text-[0.8125rem] text-ink-500">{t.docs.chooseTemplateSub}</p>
          <div className="grid gap-3">
            {Object.entries(byCategory).map(([category, list]) => (
              <div key={category}>
                <div className="mb-1 text-[length:max(11px,0.6875rem)] font-semibold uppercase tracking-wide text-ink-400">
                  {(t.docTemplates.categories as Record<string, string>)[category] ?? category}
                </div>
                <div className="grid gap-1">
                  {list.map((tpl) => (
                    <button
                      key={tpl.id}
                      disabled={pending}
                      onClick={() => pick(tpl.id)}
                      className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-start text-sm transition-colors hover:border-brand-400 hover:bg-brand-50/50 disabled:opacity-60"
                      data-template={tpl.id}
                    >
                      <span className="flex-1 font-medium">{locale === "ar" ? tpl.name_ar || tpl.name : tpl.name}</span>
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
            <Link href={`/c/${slug}/settings/documents`} className="text-[0.75rem] font-medium text-brand-700 hover:underline">
              {t.docs.manageTemplates}
            </Link>
          </div>
        </>
      )}
    </Modal>
  );
}
