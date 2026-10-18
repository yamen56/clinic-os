"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { Moon, Sun, MonitorSmartphone } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { THEME_COOKIE, readThemeCookie, type ThemePref } from "@/lib/theme";

/*
  One preference, many controls: the sidebar's button, the phone's sheet and
  the picker on My account all read and write it. A module-level store rather
  than context, because they sit in different trees (the shell, a server page)
  and should still move together when any one of them is pressed.
*/
const listeners = new Set<() => void>();
let current: ThemePref | null = null;

function getPref(): ThemePref {
  if (current === null) current = readThemeCookie(document.cookie);
  return current;
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
const serverPref = (): ThemePref => "light";

const deviceIsDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function resolve(p: ThemePref): "light" | "dark" {
  return p === "system" ? (deviceIsDark() ? "dark" : "light") : p;
}

function apply(p: ThemePref) {
  const el = document.documentElement;
  if (resolve(p) === "dark") el.setAttribute("data-theme", "dark");
  else el.removeAttribute("data-theme");
}

/*
  The click answers on the spot: no server round trip, no refresh — the cookie
  is written in the browser and the attribute flips. Transitions are held off
  for the two frames of the swap, or every button and row would fade through
  its own `transition-colors` at its own speed and the screen would shimmer.
*/
export function setThemePref(p: ThemePref) {
  current = p;
  document.cookie = `${THEME_COOKIE}=${p}; path=/; max-age=${365 * 86400}; samesite=lax`;
  const el = document.documentElement;
  el.classList.add("theme-switching");
  apply(p);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("theme-switching")));
  listeners.forEach((l) => l());
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, getPref, serverPref);
}

/**
 * Puts the theme on <html> while a themed area (the workspace, the agency
 * panel) is on screen, follows the device when the preference is `system`,
 * and takes the theme off again when the area unmounts — so a link from the
 * workspace to a patient's public page lands on the light page it should.
 *
 * The boot script in the root layout has usually applied it already; this is
 * what keeps it right after hydration and across client navigations.
 */
export function ThemeScope() {
  const pref = useThemePref();
  useLayoutEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => apply("system");
    mq.addEventListener("change", follow);
    return () => mq.removeEventListener("change", follow);
  }, [pref]);
  useLayoutEffect(() => () => document.documentElement.removeAttribute("data-theme"), []);
  return null;
}

/**
 * One button: light ⇄ dark. Shows where it will take you — a moon on a light
 * screen, a sun on a dark one — which is what people expect it to mean.
 */
export function ThemeToggle({
  onDark,
  className = "",
  onHint,
  onHintEnd,
}: {
  /** On the night sidebar rather than a page surface. */
  onDark?: boolean;
  className?: string;
  /** The folded sidebar shows its own tooltip; these feed it. */
  onHint?: (e: React.SyntheticEvent<HTMLElement>, label: string) => void;
  onHintEnd?: () => void;
}) {
  const { t } = useI18n();
  const pref = useThemePref();
  /*
    During SSR and hydration the store answers "light"; the attribute the boot
    script set is the truth about what is on screen, so the icon reads that
    once mounted (useSyncExternalStore re-renders with the client value).
  */
  const isDark = typeof document !== "undefined" ? resolve(pref) === "dark" : false;
  const label = isDark ? t.theme.toLight : t.theme.toDark;
  const Icon = isDark ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={() => {
        setThemePref(isDark ? "light" : "dark");
        onHintEnd?.();
      }}
      aria-label={label}
      title={onHint ? undefined : label}
      onMouseEnter={onHint ? (e) => onHint(e, label) : undefined}
      onFocus={onHint ? (e) => onHint(e, label) : undefined}
      onMouseLeave={onHintEnd}
      onBlur={onHintEnd}
      data-theme-toggle
      className={`grid touch-manipulation place-items-center transition-colors duration-140 ease-out ${
        onDark
          ? "h-8 w-8 rounded-ctl text-white/55 hover:bg-white/8 hover:text-white"
          : "h-9 w-9 rounded-full border border-line bg-surface text-ink-700 hover:bg-sunken"
      } ${className}`}
    >
      <Icon className="h-4.5 w-4.5" strokeWidth={1.75} />
    </button>
  );
}

/** Light · Dark · Device, for My account, where there is room to say all three. */
export function ThemePicker() {
  const { t } = useI18n();
  const pref = useThemePref();
  const options: { key: ThemePref; label: string; Icon: typeof Sun }[] = [
    { key: "light", label: t.theme.light, Icon: Sun },
    { key: "dark", label: t.theme.dark, Icon: Moon },
    { key: "system", label: t.theme.system, Icon: MonitorSmartphone },
  ];
  return (
    <div className="grid w-full gap-2">
      <div className="text-[13px] font-semibold text-ink-900">{t.theme.title}</div>
      <div role="radiogroup" aria-label={t.theme.title} className="inline-flex w-full max-w-sm rounded-ctl bg-sunken p-1 ring-1 ring-line">
        {options.map(({ key, label, Icon }) => {
          const on = pref === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setThemePref(key)}
              className={`flex h-9 flex-1 touch-manipulation items-center justify-center gap-1.5 rounded-[6px] text-[13px] font-semibold transition-colors duration-140 ease-out ${
                on ? "bg-surface text-ink-900 shadow-card ring-1 ring-line" : "text-ink-500 hover:text-ink-900"
              }`}
            >
              <Icon className="h-4 w-4" strokeWidth={1.75} />
              {label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-ink-500">{t.theme.hint}</p>
    </div>
  );
}
