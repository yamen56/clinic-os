"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useRealtime } from "@/lib/use-realtime";
import { fmtDate } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/input";
import { Badge, type StatusKey } from "@/components/ui/badge";
import { EmptyState, Tabs, Avatar } from "@/components/ui/misc";
import { DOC_STATUS_BADGE } from "@/components/esign/status";
import { DownloadSignedPdf } from "@/components/esign/download-signed";
import { NewDocumentModal, type PickableTemplate } from "@/components/esign/new-document-modal";
import type { DocumentListRow } from "@/lib/esign/queries";
import { FileSignature, Plus, Clock, Users } from "lucide-react";

/** The statuses that still need somebody to do something. */
const PENDING = ["draft", "sent", "partially_signed"];

/**
 * Everything outstanding across the whole clinic, so reception can chase
 * unsigned forms without opening patients one at a time. Sorted by how much
 * attention a row needs, not by date: a half-signed document waiting on a doctor
 * is more urgent than a draft nobody has sent.
 *
 * Both scopes arrive together and the tabs filter what is already here, so
 * pressing one is instant rather than a page load. See the page component for
 * why that is two selects and not one.
 */
export function DocumentsListClient({
  slug,
  tz,
  canManage,
  rows,
  templates,
}: {
  slug: string;
  tz: string;
  canManage: boolean;
  rows: DocumentListRow[];
  templates: PickableTemplate[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"pending" | "completed" | "all">("pending");
  const [newOpen, setNewOpen] = useState(false);

  // Status moves while staff are watching this list, so it refreshes itself.
  useRealtime(slug, ["documents", "document_signers"], () => router.refresh());

  // Both scopes are already here, so a tab is a filter, not a page load.
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
    return (
      r.title.toLowerCase().includes(needle) ||
      (r.patient_name ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <>
      <PageHeader
        title={t.docs.title}
        sub={t.docs.sub}
        action={
          canManage && (
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" />
              {t.docs.newDocument}
            </Button>
          )
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
        <SearchInput
          className="w-full sm:w-72"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.common.search}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<FileSignature />}
          title={scope === "pending" ? t.docs.emptyPending : t.docs.empty}
          body={scope === "pending" ? t.docs.emptyPendingBody : t.docs.emptyBody}
          action={
            canManage ? (
              <Button onClick={() => setNewOpen(true)}>{t.docs.newDocument}</Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {visible.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                {/*
                  Prefetched: the detail screen is several queries deep, and
                  warming it on hover/viewport is the difference between a row
                  that opens and a row that pauses first.
                */}
                <Link
                  href={`/c/${slug}/documents/${r.id}`}
                  prefetch
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  {r.patient_name ? (
                    <Avatar name={r.patient_name} size={34} />
                  ) : (
                    <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-sunken text-ink-400">
                      <FileSignature className="h-4 w-4" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium hover:text-brand-700">
                        {r.title}
                      </span>
                      <Badge status={(DOC_STATUS_BADGE[r.status] ?? "neutral") as StatusKey}>
                        {(t.docs.statuses as Record<string, string>)[r.status] ?? r.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-500">
                      {r.patient_name && <span className="font-medium">{r.patient_name}</span>}
                      {r.waiting_on && !["completed", "voided"].includes(r.status) && (
                        <span className="flex items-center gap-1 text-st-pending">
                          <Clock className="h-3 w-3" />
                          {t.docs.waitingOnN.replace("{name}", r.waiting_on)}
                        </span>
                      )}
                      {r.signer_count > 1 && (
                        <span className="flex items-center gap-1 tnum">
                          <Users className="h-3 w-3" />
                          {r.signed_count}/{r.signer_count}
                        </span>
                      )}
                      <span>{fmtDate(r.created_at, tz, locale)}</span>
                      {r.expires_at && ["sent", "partially_signed"].includes(r.status) && (
                        <span>
                          {t.docs.expiresOn.replace("{date}", fmtDate(r.expires_at, tz, locale))}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
                {(r.status === "completed" || r.final_pdf_path) && (
                  <DownloadSignedPdf
                    slug={slug}
                    documentId={r.id}
                    title={r.title}
                    variant="ghost"
                    size="icon"
                    iconOnly
                  />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <NewDocumentModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        slug={slug}
        templates={templates}
      />
    </>
  );
}
