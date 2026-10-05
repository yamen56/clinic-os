/*
  A campaign can carry one photo or one video, with the message as its caption.

  One file serves the whole audience. The upload is stored once and every
  recipient's outbox row points at the same path, so a 300-patient send is one
  object in storage, not three hundred. Nothing deletes a message's media, which
  is what makes sharing it safe; the campaign itself removes the file only when
  no recipient was ever queued (see deleteCampaignAction).

  media_kind is decided by the server from the stored file, never taken from
  the browser: images are re-encoded to JPEG on upload and videos must be MP4,
  so the extension the upload route writes is the type.

  media_meta is what WhatsApp needs to draw a video before it is downloaded —
  a small JPEG frame, the dimensions and the length. Baileys would compute the
  frame with ffmpeg, which the worker image does not have, and without it the
  recipient sees an empty grey box. The browser that picked the file decodes it
  anyway, so the frame is taken there. It lives on messages too, because the
  outbound sender reads nothing but the outbox row.
*/
alter table campaigns
  add column if not exists media_kind text check (media_kind in ('image', 'video')),
  add column if not exists media_path text,
  add column if not exists media_name text,
  add column if not exists media_mime text,
  add column if not exists media_meta jsonb;

alter table campaigns drop constraint if exists campaigns_media_whole;
alter table campaigns add constraint campaigns_media_whole
  check ((media_kind is null) = (media_path is null));

alter table messages add column if not exists media_meta jsonb;
