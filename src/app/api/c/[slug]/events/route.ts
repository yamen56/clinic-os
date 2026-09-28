import { apiClinic } from "@/lib/clinic-api";
import { subscribeClinic, type AppEvent } from "@/lib/realtime-server";

export const dynamic = "force-dynamic";

/**
 * Serverless platforms cap streaming responses, so this cannot be a truly
 * long-lived connection in production. Capping it ourselves means the stream
 * ends cleanly and the client's EventSource reconnects (and resyncs) on a
 * predictable cadence instead of being killed mid-flight by the platform.
 */
export const maxDuration = 60;

/** SSE stream of this clinic's change events (from Postgres NOTIFY triggers). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = await apiClinic(slug);
  if (!g.ok) return g.res;
  const clinicId = g.access.clinicId;
  const userId = g.access.session.user.id;

  /*
    Only the tables the screen listens to. Every write in the clinic used to be
    sent to every open tab — each outbound WhatsApp message bumps the session's
    daily count, so a campaign woke the calendar in every browser at the desk
    to deliver events it then discarded. Absent means everything, as before.
  */
  const only = new URL(req.url).searchParams.get("t");
  const wanted = only ? new Set(only.split(",").filter(Boolean)) : null;

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {}
      };
      send(`retry: 3000\n\n`);
      cleanup = await subscribeClinic(clinicId, (e: AppEvent) => {
        if (wanted && !wanted.has(e.t)) return;
        // A notification belongs to one person; a colleague's is not this tab's news.
        if (e.t === "notifications" && e.user_id && e.user_id !== userId) return;
        send(`data: ${JSON.stringify(e)}\n\n`);
      });
      heartbeat = setInterval(() => send(`: ping\n\n`), 25000);
      req.signal.addEventListener("abort", () => {
        cleanup?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
