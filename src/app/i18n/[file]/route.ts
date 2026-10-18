import { dictScript, type Encoding } from "@/lib/i18n/asset";

/**
 * The dictionary files the root layout loads in `<head>` — see lib/i18n/asset.
 *
 * Public on purpose: these are the words of the interface, which every visitor
 * of every page has always been sent. Outside the middleware's matcher because
 * it touches no database, and a file the browser keeps for a year is fetched
 * about once a deploy per person.
 */
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const script = dictScript(file);
  if (!script) return new Response("Not found", { status: 404 });

  const accept = req.headers.get("accept-encoding") ?? "";
  const encoding: Encoding | null = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
  const headers: Record<string, string> = {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": script.fresh ? "public, max-age=31536000, immutable" : "no-store",
    Vary: "Accept-Encoding",
  };
  if (!encoding) return new Response(script.body, { headers });
  return new Response(new Uint8Array(await script.encode(encoding)), {
    headers: { ...headers, "Content-Encoding": encoding },
  });
}
