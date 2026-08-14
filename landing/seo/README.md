# clinicti.app — the SEO changes this site still needs

The app domain (`app.clinicti.app`) is done in this repo: `src/app/robots.ts`,
`src/app/sitemap.ts`, and the metadata in `src/app/layout.tsx` and
`src/app/book/[bslug]/page.tsx`.

This site's source is **not in this repo**, so the three files here are the
changes it needs, ready to paste. Point me at the landing repo and I will apply
them directly instead.

## What is already right

Every one of the nine pages has a unique `<title>`, a unique description within
length, and an `og:image`. `robots.txt` allows crawling and declares a sitemap.
None of that needs touching.

## 1. `sitemap.xml` — replace the live file

The live sitemap lists `.html` URLs. Cloudflare Pages **307-redirects every one
of them** to the clean URL, so the sitemap currently submits nine redirects
rather than nine pages:

```
https://clinicti.app/index.html    → 307 → https://clinicti.app/
https://clinicti.app/demo.html     → 307 → https://clinicti.app/demo
```

A sitemap is a statement about canonical URLs, so it should name the ones that
answer with 200. `sitemap.xml` here does, with priorities and `lastmod`.

## 2. `head-additions.txt` — per page

Adds what is missing, per page: `canonical`, `og:url`, `og:site_name`,
`og:locale`, and the Twitter card tags. Nothing in it replaces an existing tag.

`canonical` is the one that matters most. Without it, `/demo` and any URL that
reaches the same page with a query string on the end (an ad click carrying
`?utm_source=…`, for instance) look like separate pages competing with each
other.

## 3. `jsonld-home.html` — index.html only

`Organization` + `SoftwareApplication` + `WebSite`.

The `sameAs` pointing at `app.clinicti.app` is doing specific work: the app
domain is now `noindex`, so a crawler has no way to learn that the two hosts are
one product unless this says so.

## Worth doing, not done here

- **Google Search Console** on both hosts, and submit both sitemaps. Nothing
  above matters until something is asking to be crawled.
- **`og:image` dimensions.** The tags exist; add `og:image:width` /
  `og:image:height` so a share preview does not reflow while it loads.
- **An English version.** Every page is Arabic. That is the right call for the
  market, and it means there is no `hreflang` to add — but it also means no
  English search reaches this site at all. A decision, not an oversight.
