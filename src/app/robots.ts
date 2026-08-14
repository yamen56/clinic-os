import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/urls";

/**
 * What a crawler may fetch on the app domain.
 *
 * This domain is a product, not a publication. Only one thing on it is meant to
 * be found in a search: a clinic's booking page. Everything else either needs a
 * session or carries a token in the URL.
 *
 * The split between "Disallow" and "noindex" here is deliberate, because they
 * are not two strengths of the same tool:
 *
 *  - `Disallow` stops the fetch. A page that is never fetched is also a page
 *    whose `noindex` is never read — so a disallowed URL that someone links to
 *    can still surface in results as a bare URL with no title. That is worse
 *    than useless for /login and /, which is why they stay crawlable and are
 *    marked `noindex` in the root layout instead. Google can only honour a
 *    `noindex` it is allowed to see.
 *  - `Disallow` is right for what should never be requested at all: the API,
 *    and the token-bearing paths where a fetch means handing a crawler somebody
 *    else's invoice or consent form.
 */
/*
  Rendered per request, not at build.

  Next.js treats this as a static route by default and runs it during the build,
  where Railway exposes no service variables — so `appUrl()` fell back to
  localhost and the deployed robots.txt advertised
  `Sitemap: http://localhost:3000/sitemap.xml` to every crawler that asked.
*/
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = appUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/book/",
        disallow: [
          "/api/",
          // Session-gated. Crawling these only ever yields the login redirect.
          "/c/",
          "/admin/",
          // Token-bearing: a fetch is a disclosure, so it must not happen.
          "/inv/",
          "/sign/",
          "/sign-device/",
          "/doc-print/",
          "/invite/",
          "/reset/",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
