"use client";

/*
  Choosing what was done to a tooth.

  The clinic's favourites first, as large chips, then what this doctor used
  lately, then everything else in groups a dentist would recognise. Every chip
  shows what the treatment will do to the tooth before it is pressed — the
  drawing is the label as much as the words are.

  Search reads Arabic and English, the abbreviations, and what people actually
  say at the chair ("سحب عصب", "تلبيسة"), through the same letter folding as the
  patient search.
*/

import { useMemo, useState } from "react";
import { Star, Plus, Search, ScanSearch, Sparkles, Waves, Scissors, Smile, Sun, Activity, Baby, CircleDot, Anchor } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { fmtDate } from "@/lib/dates";
import {
  PROCEDURE_CATEGORIES,
  fitsTooth,
  matchesQuery,
  treatmentLabel,
  treatmentSubLabel,
  type Category,
  type EntryKind,
  type Treatment,
} from "@/lib/charts/dental/catalog";
import { tooth as toothOf, type Tooth } from "@/lib/charts/dental/teeth";
import type { Paint, Person } from "@/lib/charts/dental/state";
import { LookGlyph } from "./tooth-art";

export type Favorite = { key: string; addedBy: Person; addedAt: string };

const DOT_ICON: Partial<Record<Category, React.ComponentType<{ className?: string }>>> = {
  diagnostic: ScanSearch,
  preventive: Sparkles,
  periodontic: Waves,
  surgery: Scissors,
  ortho: Smile,
  cosmetic: Sun,
  removable: Smile,
  endodontic: Activity,
  pediatric: Baby,
  findings: CircleDot,
  implant: Anchor,
};

const FRONT_LOOKS = new Set(["veneer", "bracket"]);

function glyphTooth(tr: Treatment, context: Tooth | null): Tooth {
  if (context && !context.primary) return context;
  return toothOf(FRONT_LOOKS.has(tr.look) ? "11" : "16");
}

export function TreatmentGlyph({ tr, paint, context, size = 34 }: { tr: Treatment; paint: Paint; context: Tooth | null; size?: number }) {
  if (tr.look === "dot") {
    const Icon = DOT_ICON[tr.category] ?? CircleDot;
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full"
        style={{ width: size * 0.62, height: size * 0.62, background: `var(--color-dental-${paint}-soft)`, color: `var(--color-dental-${paint})` }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
    );
  }
  return <LookGlyph look={tr.look} paint={paint} t={glyphTooth(tr, context)} uid={`g-${tr.key}`} size={size} />;
}

function Chip({
  tr,
  paint,
  context,
  starred,
  starTitle,
  onPick,
  onStar,
  disabled,
  compact,
}: {
  tr: Treatment;
  paint: Paint;
  context: Tooth | null;
  starred: boolean;
  starTitle: string;
  onPick: () => void;
  onStar: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { locale } = useI18n();
  return (
    <div className="group/chip relative min-w-0">
      <button
        type="button"
        onClick={onPick}
        disabled={disabled}
        data-treatment={tr.key}
        className={`flex w-full touch-manipulation items-center gap-2.5 rounded-ctl border bg-surface text-start transition-[border-color,background-color,transform] duration-140 ease-out hover:border-line-strong hover:bg-brand-50 active:translate-y-px disabled:pointer-events-none disabled:opacity-45 ${
          compact ? "h-11 pe-7 ps-2" : "min-h-14 py-1.5 pe-8 ps-2"
        } ${starred ? "border-brand-200" : "border-line"}`}
      >
        <TreatmentGlyph tr={tr} paint={tr.kind === "finding" ? "finding" : paint} context={context} size={compact ? 26 : 34} />
        <span className="min-w-0">
          <span className={`block font-semibold leading-tight text-ink-900 ${compact ? "truncate text-[13px]" : "line-clamp-2 text-[13px]"}`}>
            {treatmentLabel(tr, locale)}
          </span>
          {!compact && treatmentSubLabel(tr, locale) && (
            <span className="mt-0.5 block truncate text-[11px] leading-tight text-ink-500">{treatmentSubLabel(tr, locale)}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onStar}
        title={starTitle}
        aria-label={starTitle}
        aria-pressed={starred}
        className={`absolute end-1 top-1 grid h-6 w-6 place-items-center rounded-md transition-colors duration-140 hover:bg-sunken ${
          starred ? "text-warning" : "text-ink-300 opacity-100 sm:opacity-0 sm:group-hover/chip:opacity-100 sm:focus-visible:opacity-100"
        }`}
      >
        <Star className="h-3.5 w-3.5" fill={starred ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

export function TreatmentPicker({
  catalog,
  context,
  favorites,
  recent,
  paint,
  tz,
  disabled,
  mouthOnly,
  onPick,
  onToggleFavorite,
  onAddCustom,
}: {
  catalog: Treatment[];
  /** The tooth being treated; null for the whole mouth. */
  context: Tooth | null;
  favorites: Favorite[];
  recent: string[];
  /** The status about to be recorded — the chips are painted in it. */
  paint: Paint;
  tz: string;
  disabled?: boolean;
  /** The whole-mouth picker: only what is recorded on the mouth, an arch or a quadrant. */
  mouthOnly?: boolean;
  onPick: (tr: Treatment) => void;
  onToggleFavorite: (key: string) => void;
  onAddCustom: () => void;
}) {
  const { t, locale } = useI18n();
  const T = t.dental;
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<EntryKind>("procedure");
  const [cat, setCat] = useState<Category>("restorative");

  const usable = useMemo(
    () => catalog.filter((tr) => (mouthOnly ? ["mouth", "arch", "quadrant"].includes(tr.scope) : true)),
    [catalog, mouthOnly]
  );
  const fits = (tr: Treatment) => (context ? fitsTooth(tr, context) : true);
  const byKey = useMemo(() => new Map(usable.map((tr) => [tr.key, tr])), [usable]);
  const favKeys = new Set(favorites.map((f) => f.key));
  const favRow = favorites.map((f) => ({ f, tr: byKey.get(f.key) })).filter((x): x is { f: Favorite; tr: Treatment } => !!x.tr);
  const recentRow = recent.map((k) => byKey.get(k)).filter((x): x is Treatment => !!x && !favKeys.has(x.key)).slice(0, 8);

  const results = q.trim() ? usable.filter((tr) => matchesQuery(tr, q)) : [];
  const catCount = (c: Category) => usable.filter((tr) => tr.category === c && tr.kind === "procedure" && fits(tr)).length;
  const shownCats = PROCEDURE_CATEGORIES.filter((c) => catCount(c) > 0);
  // A group with nothing for this tooth (or for the whole mouth) is never the one left open.
  const activeCat: Category = kind === "finding" ? "findings" : shownCats.includes(cat) ? cat : (shownCats[0] ?? cat);
  const inCat = usable.filter((tr) => tr.category === activeCat && tr.kind === kind && fits(tr));

  const starTitle = (key: string) => {
    const f = favorites.find((x) => x.key === key);
    if (!f) return T.star;
    return T.starredBy.replace("{name}", f.addedBy.name).replace("{date}", fmtDate(f.addedAt, tz, locale));
  };
  const chip = (tr: Treatment, compact?: boolean) => (
    <Chip
      key={tr.key}
      tr={tr}
      paint={paint}
      context={context}
      starred={favKeys.has(tr.key)}
      starTitle={starTitle(tr.key)}
      onPick={() => onPick(tr)}
      onStar={() => onToggleFavorite(tr.key)}
      disabled={disabled}
      compact={compact}
    />
  );

  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={T.search}
          className="h-10 w-full rounded-ctl border border-line bg-surface ps-9 pe-3 text-base text-ink-900 placeholder:text-ink-500 transition-[border-color,box-shadow] duration-140 hover:border-line-strong focus:border-brand-600 focus:shadow-[0_0_0_3px_rgb(105_137_166/0.30)] focus:outline-none md:text-sm"
        />
      </div>

      {q.trim() ? (
        results.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">{results.slice(0, 30).map((tr) => chip(tr))}</div>
        ) : (
          <button type="button" onClick={onAddCustom} className="rounded-ctl border border-dashed border-line-strong px-3 py-4 text-sm text-ink-500 hover:bg-sunken">
            {T.noResults}
          </button>
        )
      ) : (
        <>
          {favRow.length > 0 && (
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-ink-500">
                <Star className="h-3.5 w-3.5 text-warning" fill="currentColor" />
                {T.favourites}
              </h4>
              <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">{favRow.map(({ tr }) => chip(tr))}</div>
            </section>
          )}
          {recentRow.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[12px] font-semibold text-ink-500">{T.recent}</h4>
              <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3">{recentRow.map((tr) => chip(tr, true))}</div>
            </section>
          )}

          {!mouthOnly && (
            <div className="inline-flex w-fit rounded-ctl bg-sunken p-0.5" role="tablist">
              {(["procedure", "finding"] as EntryKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={kind === k}
                  onClick={() => setKind(k)}
                  className={`h-8 rounded-[6px] px-3 text-[13px] font-semibold transition-colors duration-140 ${
                    kind === k ? "bg-surface text-ink-900 shadow-card" : "text-ink-500 hover:text-ink-700"
                  }`}
                >
                  {k === "procedure" ? T.treatments : T.findings}
                </button>
              ))}
            </div>
          )}

          {kind === "procedure" && (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {shownCats.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCat(c)}
                    className={`h-8 shrink-0 rounded-full border px-3 text-[12.5px] font-semibold transition-colors duration-140 ${
                      activeCat === c ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-surface text-ink-700 hover:bg-sunken"
                    }`}
                  >
                    {T.categories[c]}
                  </button>
                ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">{inCat.map((tr) => chip(tr))}</div>
        </>
      )}

      <button
        type="button"
        onClick={onAddCustom}
        className="flex h-10 items-center justify-center gap-2 rounded-ctl border border-dashed border-line-strong text-[13px] font-semibold text-ink-700 transition-colors hover:bg-sunken"
      >
        <Plus className="h-4 w-4" />
        {T.addCustom}
      </button>
    </div>
  );
}
