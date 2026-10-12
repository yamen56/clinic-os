/*
  Where this tab has been, so a Back button can go where the person came from.

  A patient file is opened from the patient list, the calendar, a conversation,
  a notification. Its Back used to be a link to the patient list whichever of
  those it was, which is "up", not "back" — and in the app installed on an
  iPhone there is no browser Back to fall back on. So the shell records each
  page as it arrives and the button reads the one before.

  A trail rather than `router.back()`, for two reasons:

  - Back/Forward restores the page from the router's memory without asking the
    server (see AutosaveGuard), so a list returned to that way can show a
    payment that has since been recorded as still owed. A link fetches.
  - History holds pages nobody wants to return to. A new invoice becomes the
    invoice when it is saved, and history-back from the invoice was the empty
    form. The trail drops a /new page once something replaces it.

  Per tab (sessionStorage), so two tabs keep separate trails. Storage can
  throw or be empty — private windows, cleared site data — and then the
  button simply uses its fallback.
*/

const KEY = "clinicti.trail";
const MAX = 40;

let memory: string[] | null = null;
const listeners = new Set<() => void>();

const pathOf = (url: string) => url.split(/[?#]/)[0];

/*
  The page a Back is on its way to, from our button or the browser's. Only a
  real Back drops the page left behind. Arriving at the previous page some
  other way — patient, the list from the nav, the same patient again — is a
  step forward, and the patient's Back should then go to the list.
*/
let backTo: string | null = null;

/** Called by the Back button on click, before the navigation starts. */
export function expectBack(url: string) {
  backTo = pathOf(url);
}

/** The trail as it was before the latest visit was recorded, and that visit. */
let undo: { before: string[]; url: string } | null = null;

/**
 * The browser's Back, or a phone's swipe. It cannot simply call `expectBack`:
 * Next answers `popstate` first and can render — and record — the page it
 * restores before this listener runs. When that has happened, the step is
 * taken again as a Back; when it has not, the record still to come takes it.
 * Taking a forward step "again as a Back" changes nothing, since `advance`
 * only drops a page when the one before it is the destination.
 */
export function browserWentTo(path: string) {
  backTo = path;
  if (undo && pathOf(undo.url) === path) {
    write(advance(undo.before, undo.url));
    backTo = null;
  }
}

/** A page that turns into another when it is done with: the form for a new invoice becomes the invoice. */
const transient = (path: string) => path.endsWith("/new");

function read(): string[] {
  if (memory) return memory;
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "[]");
    memory = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    memory = [];
  }
  return memory;
}

/**
 * The trail once `url` has been visited. Pure, so the button can ask what the
 * trail *will* be on the render before the recorder's effect has run, and not
 * flash the wrong destination for a frame.
 *
 * - The same page again (a tab or a filter in the query): its entry is updated,
 *   so returning to it brings the filter back with it.
 * - A Back to the page before: the page left is dropped.
 * - Anything else is a step forward, except that a transient page is replaced
 *   rather than stacked on.
 */
function advance(trail: string[], url: string): string[] {
  const path = pathOf(url);
  const top = trail[trail.length - 1];
  if (top !== undefined && pathOf(top) === path) return [...trail.slice(0, -1), url];
  if (backTo === path && trail.length >= 2 && pathOf(trail[trail.length - 2]) === path) {
    return [...trail.slice(0, -2), url];
  }
  if (top !== undefined && transient(pathOf(top))) return [...trail.slice(0, -1), url];
  return [...trail, url].slice(-MAX);
}

export function recordVisit(url: string) {
  const before = read();
  const next = advance(before, url);
  backTo = null;
  undo = { before, url };
  write(next);
}

function write(next: string[]) {
  memory = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* Kept in memory for this page's life; the fallback covers a reload. */
  }
  listeners.forEach((l) => l());
}

/**
 * The page before `path` in this tab, if it is inside `scope` — the same
 * clinic, or the admin panel. A page from another workspace is never a Back
 * target: switching clinics is not a step to undo.
 */
export function previousPage(path: string, scope: string): string | null {
  const trail = advance(read(), path);
  const prev = trail[trail.length - 2];
  if (!prev) return null;
  const p = pathOf(prev);
  return p === scope || p.startsWith(`${scope}/`) ? prev : null;
}

export function subscribeTrail(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
