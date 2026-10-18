/**
 * Light, dark, or whatever the device is set to — and the folded sidebar.
 *
 * Both are per device rather than per account, on purpose. The same receptionist
 * wants the bright theme on the front-desk monitor at noon and the dark one on
 * her phone at night; a setting on the user row would make one of those wrong.
 * So they live in cookies, like the language does before sign-in.
 *
 * No server code and no "use client", so the root layout can inline the boot
 * script and the client components can share the names.
 */

export const THEME_COOKIE = "cos_theme";
export const SIDEBAR_COOKIE = "cos_sidebar";

export type ThemePref = "light" | "dark" | "system";
export type SidebarPref = "auto" | "collapsed" | "expanded";

/**
 * Where a theme may apply: the staff workspace and the agency panel.
 *
 * Everything else under this domain is a patient's page — an invoice, a
 * booking form, a signing link, a print — and is a document designed to look
 * one way. A patient whose phone is in dark mode still gets the light invoice.
 */
export const THEMED_PATH = /^\/(c|admin)(\/|$)/;

/**
 * Runs in <head> before the first paint, so a dark-theme user never sees the
 * page flash white while React loads. Kept tiny and dependency-free: it is a
 * string, not a module. `ThemeScope` takes over once the app has hydrated.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{
if(!${THEMED_PATH.toString()}.test(location.pathname))return;
var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark|system)/);
var p=m?m[1]:"light";
if(p==="system")p=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
if(p==="dark")document.documentElement.setAttribute("data-theme","dark");
}catch(e){}})();`;

export function readThemeCookie(cookie: string): ThemePref {
  const m = cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=(light|dark|system)`));
  return (m?.[1] as ThemePref) ?? "light";
}

export function parseSidebarPref(v: string | undefined): SidebarPref {
  return v === "collapsed" || v === "expanded" ? v : "auto";
}
