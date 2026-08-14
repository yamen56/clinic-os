# The one line to change in `build.py`

Your README is right that the HTML must not be edited by hand — the fix belongs
in the generator.

## The bug

In `head()`:

```python
canonical = SITE + "/" + ("" if path == "index.html" else path)
```

For `path="demo.html"` that produces `https://clinicti.app/demo.html`. But
Cloudflare Pages serves the clean URL and **307-redirects** the `.html` form:

```
https://clinicti.app/demo.html  →  307  →  https://clinicti.app/demo
```

So every page except the home page currently tells Google "the real address is
here", and that address immediately answers "no, it is over there". A canonical
has to name a URL that returns 200, or it is discarded.

Same value feeds `og:url`, so a shared link previews through a redirect too.

## The fix

Replace that line with:

```python
    # Cloudflare Pages serves the clean URL and 307-redirects the .html form,
    # so the canonical has to name the address that actually answers 200.
    slug = "" if path == "index.html" else path[: -len(".html")]
    canonical = SITE + "/" + slug
```

Then:

```
python3 build.py
```

and redeploy. That corrects `canonical` and `og:url` on all nine pages at once.

## Verify

```
curl -s https://clinicti.app/demo | grep canonical
```

should print `https://clinicti.app/demo` — no `.html`.

## Optional, not required

Internal links (`href="demo.html"`) also go through the 307. Google follows
them fine, so this is not costing you rankings — it just spends a redirect on
every internal hop. Only worth changing if you are touching `nav()`, `footer()`
and the pager anyway.
