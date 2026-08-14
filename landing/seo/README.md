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

## 4. `llms.txt` — new file at the site root

Serve at `https://clinicti.app/llms.txt`. On Cloudflare Pages that means
dropping it in the published output directory; no config, no redirect.

### What it is, honestly

A proposed convention (llmstxt.org, late 2024), **not an adopted standard**. No
major model provider has committed to reading it. Anthropic, Stripe, Cloudflare
and Vercel publish one; that is the level of adoption it has. It costs one static
file, so it is a cheap bet rather than a sure one — do not expect it to move
anything on its own.

### Why it is still worth having

The file is written to answer the questions an assistant gets wrong when it has
to infer from marketing copy: what the product *is not* (not a directory, not
something patients sign up for), how the name is spelled, that Makan Scaling is
not part of the name, that there is no self-serve trial, and that pricing is not
published so it should not be guessed at. Those corrections are the actual value.

### Already true, and more important

The site's robots.txt blocks the **training** crawlers — GPTBot, ClaudeBot,
CCBot, Google-Extended, Applebot-Extended and the rest. It does **not** block the
**retrieval** agents: OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-User and
Bingbot all fall under `User-agent: *` → `Allow: /`.

That distinction is the whole game, and the current setting is the right one:
an assistant asked about clinic software in Jordan *today* can fetch and cite
this site, while the content is kept out of model training sets. Unblocking the
training crawlers would only affect models retrained later, and is a licensing
decision rather than an SEO one.

## Worth doing, not done here

- **Google Search Console** on both hosts, and submit both sitemaps. Nothing
  above matters until something is asking to be crawled.
- **`og:image` dimensions.** The tags exist; add `og:image:width` /
  `og:image:height` so a share preview does not reflow while it loads.
- **An English version.** Every page is Arabic. That is the right call for the
  market, and it means there is no `hreflang` to add — but it also means no
  English search reaches this site at all. A decision, not an oversight.
