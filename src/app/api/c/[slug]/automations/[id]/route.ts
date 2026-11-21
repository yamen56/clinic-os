import { NextResponse } from "next/server";
import { apiClinic } from "@/lib/clinic-api";
import { isUuid } from "@/lib/uuid";
import { saveFlow } from "@/lib/automation/save";

/**
 * The builder's autosave (useAutosave posts `{ patch: { flow } }` here).
 *
 * The whole flow every time: a flow is one graph, and half of one saved is a
 * broken one. A flow the server will not take — switched on with a problem in
 * it, a step whose settings do not read — comes back as `rejected.flow`, so
 * the screen can say why and every edit after it still goes out; only a save
 * over somebody else's newer version is a 409.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const g = await apiClinic(slug, "automations");
  if (!g.ok) return g.res;

  let body: { patch?: { flow?: Record<string, unknown> } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const flow = body.patch?.flow;
  if (!flow || typeof flow !== "object") return NextResponse.json({ ok: true });

  const r = await saveFlow(g.access, slug, { ...flow, id, recipeKey: undefined });
  if (r.error === "conflict") return NextResponse.json({ error: "conflict" }, { status: 409 });
  if (r.error === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (r.error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (r.error) return NextResponse.json({ rejected: { flow: { error: r.error, nodeId: r.nodeId ?? null } } });
  return NextResponse.json({ ok: true, updatedAt: r.updatedAt, cancelledRuns: r.cancelledRuns ?? 0 });
}
