/**
 * Which team thread is open on this screen, if any.
 *
 * The header's pop-ups read it so that a colleague's message in the thread
 * already in front of you is not announced on top of itself, while one in any
 * other thread still is. A module, not React state: the two live in different
 * parts of the tree and only the header ever reads it.
 */
export const teamView: { openThreadId: string | null } = { openThreadId: null };
