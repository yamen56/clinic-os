-- Where a booking actually happens.
--
-- Until now the answer was always "at the clinic address", and the product said
-- so in four places without ever storing it: the booking page shows the address
-- and a Google Maps link, the .ics carries LOCATION, the done screen offers a
-- button that dials the clinic. That is right for a dentist and wrong for
-- anybody whose appointment is a video call — including Clinicti's own
-- workspace, whose "appointments" are product demos with a join link.
--
-- Three additive columns, every one of them a no-op for every clinic today.

------------------------------------------------------------------------------
-- 1. Is this held in a room, or on a link?
------------------------------------------------------------------------------
alter table services
  /*
    'in_person' is the default and is every existing row, so no clinic's booking
    page moves. A service is the right home for this because it is a property of
    what was booked rather than of who booked it: a demo is always a video call
    and a filling never is, and the person picking a time should not be asked.
  */
  add column if not exists location_kind text not null default 'in_person'
    check (location_kind in ('in_person', 'online'));

comment on column services.location_kind is
  'in_person = at the clinic address (the default, and every clinic today). online = a video link, taken from whoever is hosting.';

------------------------------------------------------------------------------
-- 2. The host's standing room
------------------------------------------------------------------------------
/*
  On the member, not on the service, and the difference is load-bearing.

  A booking link with `allow_any_doctor` can send two people booking the same
  half hour to two *different* hosts. One room per service would have put both
  of those meetings in the same call. One room per host cannot, because the slot
  search already guarantees a host is in at most one appointment at a time —
  that existing guarantee is exactly what makes a static link safe here.

  Static, rather than a room generated per booking: generating one means an
  OAuth integration, tokens to refresh, and a third-party call *inside* the
  booking transaction, where an outage stops being "the link is missing" and
  becomes "you cannot book a demo".
*/
alter table clinic_members
  add column if not exists meeting_url text;

------------------------------------------------------------------------------
-- 3. What the meeting was, at the time it was booked
------------------------------------------------------------------------------
/*
  Copied off the host when the appointment is created, never read back through
  them. A host who changes their room next year must not silently rewrite where
  last month's meeting was: the WhatsApp confirmation and the calendar invite
  the customer saved both already name a URL, and the record has to keep
  agreeing with the two artefacts that have already left the building.
*/
alter table appointments
  add column if not exists meeting_url text;
