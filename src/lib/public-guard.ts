/**
 * Staying up while somebody is trying to push you over.
 *
 * The public surface — the booking link, the signing link, the invoice link —
 * takes traffic from anyone who knows a URL, and it does real work per request:
 * a slot scan, a token resolve, an object fetch. The per-IP counters in
 * `booking-public.ts` answer "is this one caller abusing us". They cannot
 * answer the question that actually takes the platform down, which is "are we
 * about to spend every database connection we own on strangers".
 *
 * Those are different failures and only the second one is fatal. `PG_POOL_MAX`
 * is 12 per web process. Twelve concurrent slot scans is not a large number of
 * visitors, and once they are in flight every logged-in doctor's page waits on
 * a connection that is not coming — the clinic goes down because a booking page
 * got popular. So public work gets a fixed allowance of the pool and the rest
 * is refused immediately.
 *
 * **Shedding, not queueing.** A queue under sustained load is a slower way to
 * fall over: the queue grows, every waiter times out anyway, and the memory
 * they occupy is spent on requests whose callers have long since gone. Refusing
 * in microseconds with a 503 costs nothing and leaves the process healthy.
 */

/**
 * How much of the connection pool strangers may hold at once.
 *
 * A third of it, floored at two. The reserved majority is what guarantees that
 * a clinic can still open a patient record during a flood — which is the whole
 * point, and is worth more than serving the last few public requests.
 */
const POOL_MAX = Number(process.env.PG_POOL_MAX || 12);
const PUBLIC_MAX = Math.max(2, Number(process.env.PUBLIC_DB_CONCURRENCY || Math.floor(POOL_MAX / 3)));

let inFlight = 0;
/** Peak concurrency and refusals since boot, for the monitoring page. */
const stats = { peak: 0, shed: 0 };

export type PublicSlot = { release: () => void };

/**
 * Claims one of the public allowance, or returns null when there is none left.
 *
 * Callers must release in a `finally`. A leaked slot is permanent — the counter
 * never recovers and the endpoint stays refused for the life of the process —
 * so this is deliberately not exposed as a wrapper that could be called without
 * one.
 */
export function takePublicSlot(): PublicSlot | null {
  if (inFlight >= PUBLIC_MAX) {
    stats.shed++;
    return null;
  }
  inFlight++;
  if (inFlight > stats.peak) stats.peak = inFlight;
  let released = false;
  return {
    release() {
      // Guarded because a double release would hand out an allowance we do not
      // have, which is worse than the leak it looks like a fix for.
      if (released) return;
      released = true;
      inFlight--;
    },
  };
}

export function publicLoad() {
  return { inFlight, max: PUBLIC_MAX, peak: stats.peak, shed: stats.shed };
}

/** 503 with a hint. Deliberately says nothing about why. */
export function overloaded(): Response {
  return new Response(JSON.stringify({ error: "busy" }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Retry-After": "5", "Cache-Control": "no-store" },
  });
}

/** 429, in the shape the public routes already return. */
export function rateLimited(retryAfterSec = 60): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSec),
      "Cache-Control": "no-store",
    },
  });
}

export type JsonRead<T> = { ok: true; body: T } | { ok: false; res: Response };

/**
 * `req.json()`, with a ceiling.
 *
 * App Router route handlers have no body limit of their own — the 4 MB cap
 * people remember belongs to the Pages API, and none of it applies here. So an
 * unauthenticated POST to a public endpoint could hand us a body of any size
 * and `req.json()` would faithfully buffer all of it into the heap before a
 * single line of our validation ran. A handful of concurrent 500 MB posts is an
 * out-of-memory kill, and the container restarts with every clinic's WhatsApp
 * session dropped.
 *
 * Content-Length is checked first because it costs nothing and rejects the
 * honest case before a byte is read. The counting loop is the real defence:
 * a chunked request declares no length, so the header is a hint and not a
 * guarantee.
 */
export async function readJsonCapped<T>(req: Request, maxBytes = 256 * 1024): Promise<JsonRead<T>> {
  const tooBig = (): JsonRead<T> => ({
    ok: false,
    res: new Response(JSON.stringify({ error: "too_large" }), {
      status: 413,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
  });

  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return tooBig();

  const body = req.body;
  let text: string;
  if (!body) {
    text = await req.text();
    if (text.length > maxBytes) return tooBig();
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling. Without this we would go on draining a body we have
        // already decided to refuse, which is exactly the work being attacked.
        await reader.cancel().catch(() => {});
        return tooBig();
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let at = 0;
    for (const ch of chunks) {
      joined.set(ch, at);
      at += ch.byteLength;
    }
    text = new TextDecoder().decode(joined);
  }

  try {
    return { ok: true, body: JSON.parse(text || "{}") as T };
  } catch {
    return {
      ok: false,
      res: new Response(JSON.stringify({ error: "bad_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }),
    };
  }
}
