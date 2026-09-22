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
    This file is compiled into the edge bundle as well as the node one, because
    the app has middleware. The edge runtime has no `fs`, and `pg` reaches for
    it — so anything leading to lib/db must be gone from that bundle entirely,
    not merely unreached at runtime.

    The `if` is what removes it. Next substitutes `process.env.NEXT_RUNTIME`
    per bundle at build time, so in the edge build this reads `if ("edge" ===
    "nodejs")` and webpack drops the whole block along with the import inside
    it. Writing the same test as an early `return` does *not* work: the
    condition folds but the import survives as reachable code, the edge bundle
    tries to resolve `pg`, and every page served through middleware 500s with
    "Can't resolve 'fs'". Which it did, until this was written this way round.

    The cost is that an error thrown inside middleware itself is not recorded.
    Middleware is the thinnest layer here — a cookie check and a counter — and
    that is the right thing to trade.
  */
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { captureError } = await import("@/lib/error-capture");

      /*
        The route *pattern* rather than the path that was requested. Next gives
        us `/c/[slug]/invoices`; the request carries `/c/happy-smile/invoices`.
        Using the latter would fingerprint one fault once per clinic, which is
        precisely the grouping this is meant to do.
      */
      const route =
        (context as { routePath?: string }).routePath ??
        (request.path ? String(request.path).split("?")[0] : null);

      const kind =
        context.routeType === "route"
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
          would not be that user's session anyway. The clinic slug in the route
          is what ties a fault to a tenant, and it is already in `route`.
        */
        digest: (err as { digest?: string })?.digest ?? null,
      });
    } catch {
      // Instrumentation must never itself throw: Next would surface it in place
      // of the original error and the real fault would be lost.
    }
  }
};
