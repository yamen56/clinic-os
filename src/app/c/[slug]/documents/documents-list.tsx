"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useRealtimeRefresh } from "@/lib/use-realtime";
import { fmtDate } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-class";
import { SearchInput } from "@/components/ui/input";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState, Tabs, Avatar } from "@/components/ui/misc";
import { DOC_STATUS_BADGE } from "@/components/esign/status";
import { DownloadSignedPdf } from "@/components/esign/download-signed";
import { NewDocumentModal, type PickableTemplate } from "@/components/esign/new-document-modal";
import type { DocumentListRow } from "@/lib/esign/queries";
import { FileSignature, Plus, Check, Clock, X, LayoutTemplate, Wand2 } from "lucide-react";

/** The statuses that still need somebody to do something. */
const PENDING = ["draft", "sent", "partially_signed"];

/**
 * Everything outstanding across the whole clinic, so reception can chase
 * unsigned forms without opening patients one at a time. Sorted by how much
 * attention a row needs, not by date: a half-signed document waiting on a doctor
 * is more urgent than a draft nobody has sent.
 *
 * A row leads with the patient and shows every signer as a chip — signed,
 * waiting or declined — so "who still has to sign?" is answered without
 * opening anything (2026-11-21: the tab was "not organised and hard to
 * understand the first time"; rows were a title, a status and a date).
 *
 * Both scopes arrive together and the tabs filter what is already here, so
 * pressing one is instant rather than a page load.
 */
export function DocumentsListClient({
  slug,
  tz,
  canManage,
  canTemplates,
  rows,
  templates,
}: {
  slug: string;
  tz: string;
  canManage: boolean;
  canTemplates: boolean;
  rows: DocumentListRow[];
  templates: PickableTemplate[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"pending" | "completed" | "all">("pending");
  const [newOpen, setNewOpen] = useState(false);

  // Status moves while staff are watching this list, so it refreshes itself.
  useRealtimeRefresh(slug, ["documents", "document_signers"], () => router.refresh());

  const counts = useMemo(
    () => ({
      pending: rows.filter((r) => PENDING.includes(r.status)).length,
      completed: rows.filter((r) => !PENDING.includes(r.status)).length,
      all: rows.length,
    }),
    [rows]
  );

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (scope === "pending" && !PENDING.includes(r.status)) return false;
    if (scope === "completed" && PENDING.includes(r.status)) return false;
    if (!needle) return true;
    return r.title.toLowerCase().includes(needle) || (r.patient_name ?? "").toLowerCase().includes(needle);
  });

  const roleLabel = (role: string) => (t.docs.roles as Record<string, string>)[role] ?? role;

  return (
    <>
      <PageHeader
        title={t.docs.title}
        sub={t.docs.sub}
        action={
          <>
            {canTemplates && (
              <Link href={`/c/${slug}/settings/documents`} className={buttonClass({ variant: "outline" })} data-templates-link>
                <LayoutTemplate className="h-4 w-4" />
                {t.docs.templates}
              </Link>
            )}
            {canManage && (
              <Button onClick={() => setNewOpen(true)}>
                <Plus className="h-4 w-4" />
                {t.docs.newDocument}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          tabs={[
            { key: "pending", label: t.docs.tabPending, count: counts.pending },
            { key: "completed", label: t.docs.tabCompleted, count: counts.completed },
            { key: "all", label: t.docs.tabAll, count: counts.all },
          ]}
          active={scope}
          onChange={(k) => setScope(k as typeof scope)}
        />
        <SearchInput className="w-full sm:w-72" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.common.search} />
      </div>

      {visible.length === 0 ? (
        rows.length === 0 ? (
          /* The first visit: what this screen is for, in three steps. */
          <Card className="px-6 py-10" data-docs-how>
            <div className="mx-auto max-w-lg text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-700 ring-1 ring-brand-100">
                <FileSignature className="h-6 w-6" strokeWidth={1.75} />
              </span>
              <h2 className="mt-3 font-display text-base font-semibold">{t.docs.howItWorks}</h2>
              <ol className="mt-4 grid gap-2.5 text-start">
                {[t.docs.stepOne, t.docs.stepTwo, t.docs.stepThree].map((step, i) => (
                  <li key={i} className="flex items-start gap-3 rounded-lg bg-subtle px-3 py-2.5 text-[0.8125rem]">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-600 text-[0.75rem] font-semibold text-on-brand tnum">
                      {i + 1}
                    </span>
                    <span className="pt-0.5">{step}</span>
                  </li>
                ))}
              </ol>
              {canManage && (
                <Button className="mt-5" onClick={() => setNewOpen(true)}>
                  <Plus className="h-4 w-4" />
                  {t.docs.newDocument}
                </Button>
              )}
            </div>
          </Card>
        ) : (
          <EmptyState
            icon={<FileSignature />}
            title={scope === "pending" ? t.docs.emptyPending : t.docs.empty}
            body={scope === "pending" ? t.docs.emptyPendingBody : t.docs.emptyBody}
          />
        )
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {visible.map((r) => {
              const done = r.signers.filter((s) => s.status === "signed").length;
              return (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3 sm:px-5" data-doc-row>
                  {/*
                    Prefetched: the detail screen is several queries deep, and
                    warming it on hover/viewport is the difference between a row
                    that opens and a row that pauses first.
                  */}
                  <Link href={`/c/${slug}/documents/${r.id}`} prefetch className="flex min-w-0 flex-1 items-center gap-3">
                    {r.patient_name ? (
                      <Avatar name={r.patient_name} size={36} />
                    ) : (
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sunken text-ink-400">
                        <FileSignature className="h-4 w-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="truncate text-sm font-semibold">{r.patient_name ?? r.title}</span>
                        <Badge status={(DOC_STATUS_BADGE[r.status] ?? "neutral") as StatusKey}>
                          {(t.docs.statuses as Record<string, string>)[r.status] ?? r.status}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[0.75rem] text-ink-500">
                        {r.patient_name && <span className="truncate font-medium text-ink-700">{r.title}</span>}
                        <span className="tnum">{fmtDate(r.created_at, tz, locale)}</span>
                        {r.expires_at && ["sent", "partially_signed"].includes(r.status) && (
                          <span>{t.docs.expiresOn.replace("{date}", fmtDate(r.expires_at, tz, locale))}</span>
                        )}
                      </div>
                      {/* Who signs, and where each of them is. */}
                      {r.signers.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1" data-doc-signers>
                          {r.signers.slice(0, 4).map((s, i) => (
                            <span
                              key={i}
                              className={`inline-flex max-w-44 items-center gap-1 rounded-full px-2 py-0.5 text-[length:max(11px,0.6875rem)] font-medium ${
                                s.status === "signed"
                                  ? "bg-st-confirmed-soft text-st-confirmed"
                                  : s.status === "declined"
                                    ? "bg-danger-soft text-danger"
                                    : "bg-st-pending-soft text-st-pending"
                              }`}
                            >
                              {s.status === "signed" ? (
                                s.auto ? <Wand2 className="h-3 w-3 shrink-0" /> : <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                              ) : s.status === "declined" ? (
                                <X className="h-3 w-3 shrink-0" />
                              ) : (
                                <Clock className="h-3 w-3 shrink-0" />
                              )}
                              <span className="truncate">{s.name || roleLabel(s.role)}</span>
                            </span>
                          ))}
                          {r.signers.length > 4 && <span className="text-[length:max(11px,0.6875rem)] text-ink-400">+{r.signers.length - 4}</span>}
                          {r.signers.length > 1 && (
                            <span className="ms-1 text-[length:max(11px,0.6875rem)] text-ink-400 tnum">
                              {t.docs.signedOfN.replace("{n}", String(done)).replace("{total}", String(r.signers.length))}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </Link>
                  {(r.status === "completed" || r.final_pdf_path) && (
                    <DownloadSignedPdf slug={slug} documentId={r.id} title={r.title} variant="ghost" size="icon" iconOnly />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <NewDocumentModal open={newOpen} onClose={() => setNewOpen(false)} slug={slug} templates={templates} />
    </>
  );
}
