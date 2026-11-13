-- The booking page's band in the clinic's colour, made optional per link.
--
-- Yamen, 2026-11-12: "make the two tone color optional". Since 0106 the page
-- opens on a band in the clinic's colour with the steps on a white sheet over
-- it. On (the default, so every link keeps the look it has today), or off: a
-- plain white page, the clinic's colour only on its buttons and on what the
-- patient has chosen.
alter table booking_links
  add column if not exists brand_header boolean not null default true;

comment on column booking_links.brand_header is
  'The booking page opens on a band in the clinic''s colour (true), or on a plain white page (false). 0107.';
