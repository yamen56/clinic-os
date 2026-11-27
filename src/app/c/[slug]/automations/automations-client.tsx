"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { useAutosave } from "@/lib/use-autosave";
import { fmtRelative } from "@/lib/dates";
import { PageHeader, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toggle, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Tabs } from "@/components/ui/misc";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { SaveIndicator } from "@/components/ui/save-indicator";
import { useToast } from "@/components/ui/toast";
import { deleteAutomationAction, duplicateAutomationAction, toggleAutomationAction } from "./actions";
import { SystemMessagesCard } from "./system-messages-card";
import { StaffAlertsCard } from "./staff-alerts-card";
import { SYSTEM_MESSAGES, type SystemMessageState } from "@/lib/system-messages";
import type { StaffAlert } from "@/lib/staff-alerts";
import type { Specialty } from "@/lib/specialties";
import type { FeatureMap } from "@/lib/features";
import { TRIGGER_CATEGORIES, triggerDef, type TriggerCategory } from "@/lib/automation/catalog";
import { TRIGGER_ICONS, fill, triggerSummary, type Lookups } from "./flow-meta";
import { TEMPLATE_GROUPS, type TemplateGroup } from "@/lib/automation/template-library";
import {
  AlertTriangle,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  MoreHorizontal,
  Plus,
  Search,
  Star,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";

type Automation = {
  id: string;
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  active: boolean;
  recipe_key: string | null;
  recipe_specialty: string;
  step_count: number;
  runs_30: number;
  waiting: number;
  failed_count: number;
  last_run: string | null;
  sent_30: number;
};

export type GalleryTemplate = {
  key: string;
  name: string;
  name_ar: string | null;
  /** What it solves and what the patient gets, in each language. */
  about: string;
  about_ar: string;
  trigger: string;
  triggerConfig: Record<string, unknown>;
  steps: string[];
  specialty: string;
  /** What it is for — the gallery's sections. */
  group: TemplateGroup;
  /** The clinic's own flow made from it (or, for a reminder, one doing the same job), if any. */
  added: { id: string; active: boolean } | null;
};

export function AutomationsClient({
  slug,
  isOwner,
  specialty,
  automations,
  messages,
  alerts,
  reviewUrl,
  mutedPatients,
  templates,
  lookups,
  modules,
  initialTab,
  openGallery,
}: {
  slug: string;
  isOwner: boolean;
  specialty: Specialty;
  automations: Automation[];
  messages: Record<string, SystemMessageState>;
  alerts: StaffAlert[];
  reviewUrl: string;
  /** Patients muted from every flow on this page, and from campaigns. */
  mutedPatients: number;
  templates: GalleryTemplate[];
  lookups: Pick<Lookups, "services" | "members">;
  modules: FeatureMap;
  initialTab?: "flows" | "messages" | "alerts";
  openGallery?: boolean;
}) {
  const { t, locale } = useI18n();
  const f = t.automations.flow;
  const { toast } = useToast();
  const router = useRouter();
  const [, start] = useTransition();
  const { patch, state } = useAutosave({ url: `/api/c/${slug}/clinic`, entityKey: `msgwindow:${slug}` });
  void specialty;

  /*
    Three tabs rather than one long page. Everything that sends on its own now
    lives here — flows, the platform's own messages, the team's alerts — and
    stacked into one column that is a scroll long enough that the bottom third
    would never be found. The counts are on the tabs precisely so nobody has to
    open one to discover whether it holds anything.
  */
  const [tab, setTab] = useState<"flows" | "messages" | "alerts">(initialTab ?? "flows");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<TriggerCategory | "">("");
  const [showOff, setShowOff] = useState(true);
  const [gallery, setGallery] = useState(Boolean(openGallery));
  const [menu, setMenu] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());

  /*
    Enabling an automation moves its row between the two sections, so the knob
    alone moving instantly is not enough — the row has to travel with it.
    React drops the optimistic value once the transition ends, at which point
    the refreshed server data is already in place, and a failed write simply
    leaves the row where it was.
  */
  const [shown, setShown] = useOptimistic(
    automations,
    (rows: Automation[], change: { id: string; active: boolean }) =>
      rows.map((a) => (a.id === change.id ? { ...a, active: change.active } : a))
  );

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return shown.filter(
      (a) =>
        !gone.has(a.id) &&
        (!cat || triggerDef(a.trigger_type)?.category === cat) &&
        (!s || a.name.toLowerCase().includes(s) || a.description.toLowerCase().includes(s))
    );
  }, [shown, q, cat, gone]);
  const active = visible.filter((a) => a.active);
  const inactive = visible.filter((a) => !a.active);
  const usedCats = TRIGGER_CATEGORIES.filter((c) => shown.some((a) => triggerDef(a.trigger_type)?.category === c));

  const row = (a: Automation) => {
    const Icon = TRIGGER_ICONS[a.trigger_type] ?? Zap;
    const sum = triggerSummary(t.automations, a.trigger_type, a.trigger_config, { services: lookups.services, members: lookups.members as Lookups["members"] }, locale);
    const stats = [
      a.runs_30 ? fill(f.runs30, { n: a.runs_30 }) : null,
      a.sent_30 ? fill(f.sent30, { n: a.sent_30 }) : null,
      a.waiting ? fill(f.waitingNow, { n: a.waiting }) : null,
    ].filter(Boolean);
    return (
      /*
        A paused one is said by its switch and by sitting under "Off", not by
        fading the row: at 75% its two grey lines fell to 2.3–3.3:1 and could
        not be read on a phone (2026-11-27). Only the name steps back.
      */
      <li key={a.id}>
        <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
          <Toggle
            checked={a.active}
            label={t.automations.enable}
            onChange={(v) =>
              start(async () => {
                setShown({ id: a.id, active: v });
                const r = await toggleAutomationAction(slug, a.id, v);
                if (r.error === "invalid_flow") {
                  toast(f.invalidFlow, "error");
                  return;
                }
                if (r.error) return toast(t.common.genericError, "error");
                toast(v ? t.automations.enabled : t.automations.disabled);
              })
            }
          />
          <span className="hidden h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 sm:grid">
            <Icon className="h-4.5 w-4.5" />
          </span>
          <Link href={`/c/${slug}/automations/${a.id}`} className="min-w-0 flex-1">
            {/*
              min-w-0 here as well as on the Link. A flex item's floor is its
              content width unless it is told otherwise, so without this the
              truncate below never truncates: the name simply pushes the row wider
              than the phone, and the whole page starts scrolling sideways.
            */}
            <div className="flex min-w-0 items-center gap-2">
              <span className={`min-w-0 truncate text-sm font-semibold ${a.active ? "" : "text-ink-700"}`}>{a.name}</span>
              {a.failed_count > 0 && (
                <Badge status="danger">
                  <AlertTriangle className="h-3 w-3" />
                  {a.failed_count}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 truncate text-[0.8125rem] text-ink-500">
              {sum.title}
              {sum.detail ? ` · ${sum.detail}` : ""} · {a.step_count === 1 ? f.stepOne : fill(f.stepsN, { n: a.step_count })}
            </div>
            <div className="mt-0.5 truncate text-[0.75rem] text-ink-400" suppressHydrationWarning>
              {stats.length ? `${stats.join(" · ")} · ` : ""}
              {a.last_run ? fill(f.lastRun, { when: fmtRelative(a.last_run, locale) }) : f.neverRan}
            </div>
          </Link>
          <div className="relative">
            <button
              type="button"
              aria-label={f.edit}
              onClick={() => setMenu(menu === a.id ? null : a.id)}
              className="grid h-9 w-9 place-items-center rounded-lg text-ink-400 hover:bg-sunken hover:text-ink-700"
            >
              <MoreHorizontal className="h-4.5 w-4.5" />
            </button>
            {menu === a.id && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
                <div className="absolute end-0 top-full z-40 mt-1 grid min-w-44 gap-0.5 rounded-ctl border border-line bg-surface p-1 shadow-pop">
                  <Link
                    href={`/c/${slug}/automations/${a.id}?tab=activity`}
                    className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[0.8125rem] hover:bg-sunken"
                  >
                    <History className="h-4 w-4 text-ink-500" />
                    {t.automations.history}
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      start(async () => {
                        const r = await duplicateAutomationAction(slug, a.id, fill(f.copyName, { name: a.name }));
                        if (r.error || !r.id) return toast(t.common.genericError, "error");
                        toast(f.duplicated);
                        router.push(`/c/${slug}/automations/${r.id}`);
                      });
                    }}
                    className="flex items-center gap-2 rounded-md px-2.5 py-2 text-start text-[0.8125rem] hover:bg-sunken"
                  >
                    <Copy className="h-4 w-4 text-ink-500" />
                    {f.duplicate}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      setDeleting(a);
                    }}
                    className="flex items-center gap-2 rounded-md px-2.5 py-2 text-start text-[0.8125rem] text-danger hover:bg-danger-soft"
                  >
                    <Trash2 className="h-4 w-4" />
                    {f.delete}
                  </button>
                </div>
              </>
            )}
          </div>
          <Link href={`/c/${slug}/automations/${a.id}`} className="hidden text-ink-300 hover:text-ink-700 sm:block" aria-hidden tabIndex={-1}>
            <ChevronRight className="h-4.5 w-4.5 rtl:rotate-180" />
          </Link>
        </div>
      </li>
    );
  };

  return (
    <>
      <PageHeader
        title={t.automations.title}
        sub={t.automations.sub}
        action={
          <Button onClick={() => setGallery(true)}>
            <Plus className="h-4 w-4" />
            {t.automations.newAutomation}
          </Button>
        }
      />

      <div className="mb-4">
        <Tabs
          tabs={[
            { key: "flows", label: t.automations.tabFlows, count: shown.filter((a) => a.active).length },
            { key: "messages", label: t.automations.tabMessages, count: SYSTEM_MESSAGES.length },
            { key: "alerts", label: t.automations.tabAlerts, count: alerts.length },
          ]}
          active={tab}
          onChange={(k) => setTab(k as typeof tab)}
        />
      </div>

      {tab === "flows" && (
        <>
          {automations.length === 0 ? (
            <EmptyState
              icon={<Workflow />}
              title={t.automations.empty}
              body={f.gallerySub}
              action={<Button onClick={() => setGallery(true)}>{t.automations.newAutomation}</Button>}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {/*
                grid-cols-1, not a bare grid. A grid's implicit column is sized
                `auto`, whose floor is the min-content width of what it holds — and a
                row whose trigger line is `truncate` (so, nowrap) has a min-content
                of whatever that text measures. The card therefore refused to be
                narrower than its longest automation, pushed past the edge of the
                phone, and took the page's whole layout width with it. `grid-cols-1`
                is `minmax(0, 1fr)`: the floor becomes zero and the truncation that
                was asked for all along finally happens.
              */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-56">
                  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={f.searchFlows} className="ps-9" />
                </div>
                {usedCats.length > 1 && (
                  <div className="flex flex-wrap gap-1.5">
                    {(["", ...usedCats] as const).map((c) => (
                      <button
                        key={c || "all"}
                        type="button"
                        aria-pressed={cat === c}
                        onClick={() => setCat(c)}
                        className={`touch-manipulation rounded-full border px-3 py-1 text-[0.75rem] max-md:py-2 font-medium ${
                          cat === c ? "border-brand-600 bg-brand-600 text-on-brand" : "border-line bg-surface text-ink-700 hover:border-line-strong"
                        }`}
                      >
                        {c ? (f.triggerCategories as Record<string, string>)[c] : f.all}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {active.length > 0 && (
                <Card>
                  <CardHeader title={f.onSection} />
                  <ul className="divide-y divide-line">{active.map(row)}</ul>
                </Card>
              )}
              {inactive.length > 0 && (
                <Card>
                  <button
                    type="button"
                    onClick={() => setShowOff((o) => !o)}
                    className="flex w-full items-center justify-between gap-3 px-5 py-4 text-start"
                    aria-expanded={showOff}
                  >
                    <span className="text-[0.9375rem] font-semibold">
                      {f.offSection} <span className="text-ink-400">· {inactive.length}</span>
                    </span>
                    <ChevronDown className={`h-4.5 w-4.5 text-ink-400 transition-transform ${showOff ? "rotate-180" : ""}`} />
                  </button>
                  {showOff && <ul className="divide-y divide-line border-t border-line">{inactive.map(row)}</ul>}
                </Card>
              )}
              {!visible.length && <p className="py-6 text-center text-sm text-ink-500">{f.noMatches}</p>}
            </div>
          )}

          {/* No sending window here any more: automations send at any hour (2026-11-10). */}
          <Card className="mt-4">
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <Star className="h-4 w-4 text-ink-400" />
                  {f.reviewLink}
                </span>
              }
              sub={f.reviewLinkSub}
              action={<SaveIndicator state={state} />}
            />
            <div className="px-5 py-4">
              <Input
                type="url"
                dir="ltr"
                defaultValue={reviewUrl}
                disabled={!isOwner}
                placeholder={f.reviewLinkPlaceholder}
                onChange={(e) => patch({ google_review_url: e.target.value.trim() })}
              />
            </div>
          </Card>

          {/*
            The other thing that decides whether a flow on this page runs.

            Stated here, beside the sending window, because both are limits on
            everything above rather than settings of any one automation — and
            because the switch itself lives on a patient file, which is not
            somewhere anybody would think to look for the rule.
          */}
          <Card className="mt-4">
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <BellOff className="h-4 w-4 text-ink-400" />
                  {t.automations.optOut}
                </span>
              }
              sub={t.automations.optOutSub}
            />
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <span className="text-sm text-ink-500">
                {mutedPatients === 0
                  ? t.automations.optOutNone
                  : t.automations.optOutCount.replace("{n}", String(mutedPatients))}
              </span>
              {mutedPatients > 0 && (
                <Link href={`/c/${slug}/patients?optedOut=1`} className="text-[0.8125rem] font-medium text-brand-700 hover:underline">
                  {t.automations.optOutSee}
                </Link>
              )}
            </div>
          </Card>
        </>
      )}

      {tab === "messages" && <SystemMessagesCard slug={slug} messages={messages} />}

      {tab === "alerts" && <StaffAlertsCard slug={slug} alerts={alerts} />}

      <TemplateGallery
        open={gallery}
        onClose={() => setGallery(false)}
        slug={slug}
        templates={templates}
        lookups={lookups}
        modules={modules}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={t.automations.deleteAutomation}
        body={f.deleteBody}
        confirmLabel={t.common.delete}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          const a = deleting;
          setDeleting(null);
          if (!a) return;
          setGone((g) => new Set([...g, a.id]));
          start(async () => {
            const r = await deleteAutomationAction(slug, a.id);
            if (r.error) {
              setGone((g) => new Set([...g].filter((x) => x !== a.id)));
              toast(t.common.genericError, "error");
            }
          });
        }}
      />
    </>
  );
}

function TemplateGallery({
  open,
  onClose,
  slug,
  templates,
  lookups,
  modules,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  templates: GalleryTemplate[];
  lookups: Pick<Lookups, "services" | "members">;
  modules: FeatureMap;
}) {
  const { t, locale } = useI18n();
  const f = t.automations.flow;
  const usable = templates.filter((tp) => {
    const def = triggerDef(tp.trigger);
    return def && modules[def.module];
  });

  /*
    One row each, grouped by what it is for, with what the clinic already runs
    marked and opened rather than added a second time — two copies of the
    day-before reminder is every patient reminded twice.
  */
  const row = (tp: GalleryTemplate) => {
    const Icon = TRIGGER_ICONS[tp.trigger] ?? Zap;
    const sum = triggerSummary(t.automations, tp.trigger, tp.triggerConfig, { services: lookups.services, members: lookups.members as Lookups["members"] }, locale);
    const about = locale === "ar" ? tp.about_ar || tp.about : tp.about;
    return (
      <li key={tp.key}>
        <Link
          href={tp.added ? `/c/${slug}/automations/${tp.added.id}` : `/c/${slug}/automations/new?template=${encodeURIComponent(tp.key)}`}
          data-template={tp.key}
          data-template-added={tp.added ? "1" : undefined}
          className="flex items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-sunken"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Icon className="h-4.5 w-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[0.875rem] font-semibold text-ink-900">{(locale === "ar" ? tp.name_ar : tp.name) || tp.name}</span>
              {tp.added && (
                <Badge status={tp.added.active ? "ok" : "neutral"}>
                  <Check className="h-3 w-3" />
                  {tp.added.active ? f.templateOn : f.templateAdded}
                </Badge>
              )}
            </span>
            {/* What it is for — the problem it solves and what the patient receives. */}
            {about && (
              <span className="mt-0.5 line-clamp-2 block text-[0.78125rem] leading-relaxed text-ink-700" data-template-about>
                {about}
              </span>
            )}
            <span className="mt-1 block text-[length:max(11px,0.71875rem)] text-ink-400">
              {sum.title}
              {sum.detail ? ` · ${sum.detail}` : ""} · {tp.steps.length === 1 ? f.stepOne : fill(f.stepsN, { n: tp.steps.length })}
            </span>
          </span>
          <ChevronRight className="mt-2 h-4 w-4 shrink-0 text-ink-300 rtl:rotate-180" />
        </Link>
      </li>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title={f.gallery} wide>
      <p className="mb-4 text-[0.8125rem] text-ink-500">{f.gallerySub}</p>
      <Link
        href={`/c/${slug}/automations/new`}
        data-template="scratch"
        className="mb-5 flex items-center gap-3 rounded-xl border border-dashed border-brand-400 bg-brand-50/40 p-4 transition-colors hover:border-brand-600 hover:bg-brand-50"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-600 text-on-brand">
          <Plus className="h-5 w-5" />
        </span>
        <span>
          <span className="block text-sm font-semibold text-ink-900">{f.scratch}</span>
          <span className="block text-[0.75rem] text-ink-500">{f.scratchSub}</span>
        </span>
      </Link>

      <div className="grid gap-5">
        {TEMPLATE_GROUPS.map((g) => {
          const items = usable.filter((tp) => tp.group === g);
          if (!items.length) return null;
          return (
            <section key={g}>
              <h4 className="eyebrow mb-1 px-3">{(f.templateGroups as Record<string, string>)[g]}</h4>
              <ul className="-mx-1 grid gap-0.5">{items.map(row)}</ul>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
