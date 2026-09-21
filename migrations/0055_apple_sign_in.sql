-- Signing in with Apple, on the same terms as Google.
--
-- This is here for two reasons. The first is the App Store: an app that offers
-- any third-party sign-in must offer Apple's as well, so shipping Clinicti to
-- iPhones is blocked on this column existing. The second is the same reason
-- Google Sign-In exists — a clinic owner who has never chosen a password should
-- still be able to get in from a phone.
--
-- The invite-only rule is unchanged and is the whole point: a verified Apple ID
-- proves who somebody is, never that anyone asked them here. The callback
-- matches an existing user and refuses when it finds none.
--
-- `apple_sub` is Apple's stable identifier for the account *at this client*.
-- Unlike Google's it is scoped to the Services ID, so it survives an email
-- change but would NOT survive moving the app to a different Apple team — which
-- is why the first match is still by address, exactly as it is for Google.

alter table users
  add column if not exists apple_sub text,
  add column if not exists apple_linked_at timestamptz;

-- One Apple ID cannot be two users. Partial, because almost every row is null
-- and a plain unique index would not allow that.
create unique index if not exists users_apple_sub_idx
  on users (apple_sub) where apple_sub is not null;
