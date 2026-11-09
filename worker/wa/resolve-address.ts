/**
 * Finding the address a message will actually reach.
 *
 * WhatsApp has moved accounts onto "LID" addressing. For a migrated account the
 * old `<phone>@s.whatsapp.net` no longer routes: the socket accepts the send,
 * hands back a message id, and the message is never delivered — no error, no
 * bounce, nothing in the inbox to notice. A chat where the patient wrote first
 * is fine because their message told us the address; a number the clinic writes
 * to first has to have it resolved.
 *
 * There are two ways to ask, and which exist depends on the library version:
 *
 *   - `signalRepository.lidMapping.getLIDForPN()` — the real resolver, added in
 *     Baileys 7. Authoritative, cached, and what this is really waiting for.
 *   - `onWhatsApp()` — present in 6.7, which queries with the LID protocol and
 *     may return a `lid` beside the legacy jid.
 *
 * Both are probed at runtime rather than imported, so this works on either
 * version and starts using the better one the moment it is available.
 */

export type ResolvedAddress = {
  /** Where to send. Null when WhatsApp says there is no account. */
  jid: string | null;
  /** The bare LID, when we learned one. */
  lid: string | null;
  /** Null when WhatsApp declined to answer — which is not the same as "no". */
  exists: boolean | null;
};

type MaybeSock = {
  onWhatsApp?: (phone: string) => Promise<
    { jid?: string; exists?: unknown; lid?: unknown }[] | undefined
  >;
  signalRepository?: {
    lidMapping?: {
      getLIDForPN?: (pn: string) => Promise<string | null | undefined>;
    };
  };
};

const asLidJid = (raw: string): string => (raw.includes("@") ? raw : `${raw}@lid`);
const bareLid = (jid: string): string => jid.split("@")[0];

export async function resolveSendAddress(
  sock: unknown,
  phoneE164: string
): Promise<ResolvedAddress> {
  const s = sock as MaybeSock;
  const pnJid = `${phoneE164.replace("+", "")}@s.whatsapp.net`;

  /*
    The mapping store first. It answers for numbers `onWhatsApp` will not, and
    it is the difference between a message arriving and vanishing — so when it
    exists, its answer wins.
  */
  const mapper = s.signalRepository?.lidMapping?.getLIDForPN;
  if (typeof mapper === "function") {
    try {
      const lid = await mapper.call(s.signalRepository!.lidMapping, pnJid);
      if (lid) {
        const jid = asLidJid(String(lid));
        return { jid, lid: bareLid(jid), exists: true };
      }
    } catch {
      // Fall through: a resolver failure is not a verdict on the number.
    }
  }

  if (typeof s.onWhatsApp !== "function") return { jid: null, lid: null, exists: null };

  /*
    What the answer means is Baileys' to say, so it is read the way Baileys
    builds it (Socket/socket.js, onWhatsApp): the query's list is filtered to
    contacts WhatsApp marked `type="in"` — registered — so a number with no
    account is simply left out and the call returns []. It returns undefined
    only when the query itself did not come back as a result.

    This used to read [] as "WhatsApp declined to answer" and send anyway, to a
    phone address nobody is at. The socket accepts that without complaint, so
    every message to a landline or a mistyped number showed one grey tick for
    ever. By the time we are here the LID lookup above has also come back
    empty, so two separate questions have both said there is no account.

    A wrong "no" is not permanent: the outbox asks again after a day, and
    "Send again" in the inbox asks again at once.
  */
  const found = await s.onWhatsApp(phoneE164);
  if (!Array.isArray(found)) return { jid: null, lid: null, exists: null };
  const [hit] = found;
  if (!hit || hit.exists === false) return { jid: null, lid: null, exists: false };

  const rawLid = typeof hit.lid === "string" && hit.lid ? String(hit.lid) : null;
  if (rawLid) {
    const jid = asLidJid(rawLid);
    return { jid, lid: bareLid(jid), exists: true };
  }
  // No LID offered: the account is still reachable the old way, or the library
  // is too old to be told otherwise.
  return { jid: hit.jid ?? pnJid, lid: null, exists: true };
}
