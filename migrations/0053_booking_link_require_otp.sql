------------------------------------------------------------------------------
-- WhatsApp verification becomes the clinic's choice, per link
--
-- Every public booking has always passed through a six-digit code sent on
-- WhatsApp. That is the right default and it stays the default: it proves the
-- number belongs to whoever is booking, which is what makes the reminder
-- arrive, the confirmation land, and a no-show reachable. It is also the only
-- thing standing between a public form and a diary full of bookings made with
-- somebody else's number.
--
-- But it is a step, and a step costs bookings. A clinic running an ad to a cold
-- audience, a link handed out at a desk where the patient is standing in front
-- of you, a demo page for a prospect who has already given a number twice — in
-- those cases the code is friction protecting against a risk the clinic has
-- decided it does not have. That is a judgement about their own practice, and
-- they are the ones who see the abandoned bookings.
--
-- So: per link, not per clinic. The same clinic can keep the code on the public
-- page it advertises and take it off the one it uses at the front desk.
------------------------------------------------------------------------------

alter table booking_links
  add column if not exists require_otp boolean not null default true;

------------------------------------------------------------------------------
-- `default true`, so every existing link keeps verifying.
--
-- The alternative — defaulting to false and letting clinics opt in — would have
-- silently removed verification from every booking page already printed on a
-- card and running in an ad, on the deploy that shipped this. A setting that
-- weakens a check must never arrive switched on.
--
-- Nothing here records *why* a particular booking went unverified. Two very
-- different things now lead to one: the clinic turned the code off, and the
-- clinic's WhatsApp was disconnected at that moment. The first is a decision
-- and the second is a fault, so they are written as different notes on the
-- appointment rather than collapsed into one flag on this row.
------------------------------------------------------------------------------
