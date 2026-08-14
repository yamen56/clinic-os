-- Signing in with Google, without turning the product into a self-serve one.
--
-- Clinicti has no public sign-up: a clinic is created by the agency and its
-- staff arrive by invitation. Google Sign-In has to preserve that. It is a
-- second way through the door for somebody who already has a key, never a way
-- of cutting one — so the callback matches an existing user and refuses when it
-- finds none, rather than creating an account for whoever presented a Gmail
-- address.
--
-- `google_sub` is Google's stable identifier for the account. Email is what we
-- match on the first time, because that is what an invitation was sent to, but
-- it is not what we match on afterwards: people change the email on a Google
-- account, and a match by address alone would follow the address to whoever
-- holds it next.

alter table users
  add column if not exists google_sub text,
  add column if not exists google_linked_at timestamptz;

-- One Google account cannot be two users. Partial, because almost every row is
-- null and a plain unique index would not allow that.
create unique index if not exists users_google_sub_idx
  on users (google_sub) where google_sub is not null;
