/* Clinicti service worker: installable PWA shell + web push. */

const SHELL_CACHE = "clinic-os-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(["/offline"])).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/**
 * Network-first for navigations so staff always see live data; the offline
 * page is the fallback when the network is gone. API calls are never cached —
 * stale clinical data is worse than an error.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  event.respondWith(
    fetch(request).catch(() =>
      caches.match("/offline").then((r) => r || new Response("Offline", { status: 503 }))
    )
  );
});

/** The number on the installed app's icon. Not every platform has one. */
function setBadge(n) {
  try {
    const nav = self.navigator;
    if (typeof n === "number" && nav && "setAppBadge" in nav) {
      return (n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge()).catch(() => {});
    }
  } catch {}
  return Promise.resolve();
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Clinicti", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Clinicti";
  // The direction follows the words, not the product's default: a notification
  // written in English was laid out right-to-left with its punctuation flipped.
  const lang = payload.lang === "en" ? "en" : "ar";
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: payload.body || "",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge.png",
        dir: lang === "ar" ? "rtl" : "ltr",
        lang,
        tag: payload.tag || undefined,
        renotify: !!payload.tag,
        timestamp: Date.now(),
        data: { url: payload.url || "/", id: payload.id || null },
      }),
      setBadge(payload.badge),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin).href;

  // Opening it on the phone is reading it: the bell in the app should agree.
  const markRead = data.id
    ? fetch("/api/me/notifications", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: data.id }),
      }).catch(() => {})
    : Promise.resolve();

  const open = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
    // Already showing that page: just bring it forward.
    const exact = list.find((c) => c.url === url);
    if (exact && "focus" in exact) return exact.focus();
    for (const client of list) {
      if (!("focus" in client)) continue;
      /*
        `navigate` only works on a window this worker controls, and rejects on
        one it does not — a tab opened before the worker installed. That
        rejection used to end the handler: the tap did nothing at all.
      */
      try {
        if ("navigate" in client) {
          const moved = await client.navigate(url);
          return (moved || client).focus();
        }
      } catch {}
    }
    return self.clients.openWindow(url);
  });

  event.waitUntil(Promise.all([markRead, open]));
});
