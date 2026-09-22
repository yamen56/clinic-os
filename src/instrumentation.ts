import type { Instrumentation } from "next";

/**
 * Every server-side error in the app, in one place.
 *
 * Next calls this for anything that throws out of a server component, a route
 * handler or a server action. That is what makes it the right seam: the
 * alternative is remembering a try/catch in each of the several hundred places
 * that can throw, and the ones that get forgotten are exactly the ones nobody
 * is watching.
 *
 * It replaces nothing — the error boundaries still render, the request still
 * fails the way it did — it only means somebody finds out.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context
) => {
  /*
    The edge runtime has no `pg`, and this file is loaded into both. A static
    import would make the middleware bundle reach for a driver it cannot run, so
    the capture module is pulled in only where it works. Middleware errors are
    the loss here; they are also the thinnest layer in the app.
  */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { captureError } = await import("@/lib/error-capture");

    /*
      The route *pattern* rather than the path that was requested. Next gives us
      `/c/[slug]/invoices`; the request carries `/c/happy-smile/invoices`. Using
      the latter would fingerprint one fault once per clinic, which is precisely
      the grouping this is meant to do.
    */
    const route =
      (context as { routePath?: string }).routePath ??
      (request.path ? String(request.path).split("?")[0] : null);

    const kind =
      context.routerKind === "Pages Router"
        ? "server"
        : context.routeType === "route"
          ? "route-handler"
          : context.routeType === "action"
            ? "action"
            : "server";

    await captureError(err, {
      route,
      kind,
      /*
        No session lookup here. This runs while a request is already failing,
        and reaching for `getSession()` would mean another database round trip
        on the unhappy path — plus the request context is gone by now, so it
        would not be that user's session anyway. The clinic slug in the route is
        what ties a fault to a tenant, and it is already in `route`.
      */
      digest: (err as { digest?: string })?.digest ?? null,
    });
  } catch {
    // Instrumentation must never itself throw: Next would surface it in place
    // of the original error and the real fault would be lost.
  }
};
