# Brand assets

Clinicti — كلينيكتي. The product stands on its own name: nothing in its copy,
chrome or email names the company behind it.

`logo-mark-primary.png` is the double-wave mark, **white on transparency**.
That single fact decides most of what follows: it can only be placed on a dark
surface. The sidebar's night panel and the login page are dark already, and
everywhere else the mark needs a plate under it.

`npm run icons` builds every derived asset from that one file, compositing it
onto the brand navy (`#0b1220`) — the PWA icons, the favicon, and
`mark-light.png`, which is the logo emails use. Emails are the reason that last
one is generated rather than copied: an email body is white, so the raw mark
would be an invisible rectangle in every invitation we send.

**Replacing `logo-mark-primary.png` and re-running `npm run icons` rebrands the
whole product.** Nothing else needs editing.

Rules worth repeating:

- Use the mark **alone** — never set the wordmark in type beside it in app chrome.
- Never redraw it in SVG/CSS, never recolor it, never add effects.
- Clear space ≥ the mark's own height. Minimum size 20px.

| File | Where it's used | Generated? |
|---|---|---|
| `logo-mark-primary.png` | Sidebar (64px), login (72px), source for all icons | no — the source |
| `mark-light.png` | Email header logo | yes, `npm run icons` |
| `logo-mark-wide.png` | Wide lockup, kept for decks and docs | no |
| `bg-aurora-grain.png` | Login background, in place of the CSS gradient | no |
