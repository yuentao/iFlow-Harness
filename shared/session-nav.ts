/**
 * Session navigation for the Alt+← / Alt+→ shortcuts (pure, testable).
 * Archived sessions stay out of the cycle — they are a separate, collapsed
 * section in the history dropdown and should not be reached by accident.
 */

export interface SessionNavItem {
  id: string;
  archived?: boolean;
}

/** Previous (-1) / next (+1) non-archived session id, wrapping at the ends. */
export function adjacentSessionId(
  sessions: readonly SessionNavItem[],
  activeId: string | null,
  direction: -1 | 1,
): string | null {
  const list = sessions.filter((session) => !session.archived);
  if (list.length === 0) return null;
  const index = activeId ? list.findIndex((session) => session.id === activeId) : -1;
  if (index === -1) return direction > 0 ? list[0]!.id : list[list.length - 1]!.id;
  return list[(index + direction + list.length) % list.length]!.id;
}
