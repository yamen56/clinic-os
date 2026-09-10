------------------------------------------------------------------------------
-- A booking link that is about one thing
--
-- The public page always opened on "choose a service". For a clinic whose link
-- offers one — a campaign link for a single treatment, a demo booking, a
-- consultation page shared in one ad — that first screen is a menu with a
-- single item: a tap that asks the patient to confirm the one thing the page
-- already said it was for.
--
-- The doctor step has always collapsed when there is nothing to choose
-- (`doctors.length > 1 && !lockedDoctor` in the wizard). This gives services
-- the same treatment, with one difference: it is opt-in rather than automatic.
-- A clinic with a single service may still want that screen, because it is
-- where the price and the duration are stated before anyone commits, and
-- silently removing it from every existing link would change pages that are
-- already printed on cards and running in ads.
------------------------------------------------------------------------------

alter table booking_links
  add column if not exists skip_service_step boolean not null default false;

------------------------------------------------------------------------------
-- No constraint tying this to the number of services, deliberately.
--
-- `service_ids` is a set the clinic edits freely, and an empty array means
-- "every bookable service" — so how many services a link actually resolves to
-- is a question about the services table, not about this row, and it changes
-- when somebody deactivates a service rather than when they edit this link. A
-- CHECK could not see that, and a trigger would reject an edit for a reason the
-- clinic did not cause.
--
-- The rule lives where the answer is known instead: the page honours this only
-- when the link resolves to exactly one service, and shows the step otherwise.
-- Turning it on for a link with three services is therefore harmless — nothing
-- is skipped — and the setting starts working by itself if the clinic later
-- narrows the link to one.
------------------------------------------------------------------------------
