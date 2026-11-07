/**
 * What the team chat's screen and its server agree on, kept apart from
 * `team-chat.ts` so the browser can import it without the server half.
 */

/** A sender may correct a message for this long after sending it, as in WhatsApp. */
export const EDIT_MINUTES = 15;

/** The reactions offered with one tap. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "🙏", "✅"];

const TITLES = new Set(["dr", "dr.", "doctor", "د", "د.", "دكتور", "دكتورة", "الدكتور", "الدكتورة"]);

/**
 * What a chat calls somebody in passing ("… is typing", "Reply to …"): the first
 * name, with the title kept when there is one, so "Dr Omar Saleh" is "Dr Omar"
 * rather than "Dr".
 */
export function shortName(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return TITLES.has(words[0].toLowerCase()) && words[1] ? `${words[0]} ${words[1]}` : words[0];
}
