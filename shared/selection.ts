/**
 * Selecting several rows of a list. The anchor is the row last picked without
 * shift; a shift-click reaches from there to the row clicked.
 */

/**
 * The selection after a click on `targetId`, with `anchorId` held. Everything
 * between anchor and target joins the selection — a range never deselects,
 * which is what dragging across rows is expected to do. Without a usable
 * anchor (none yet, or filtered away) the target alone toggles.
 */
export function rangeSelection(
  selected: number[],
  visibleIds: number[],
  anchorId: number | null,
  targetId: number,
): number[] {
  const from = anchorId === null ? -1 : visibleIds.indexOf(anchorId);
  const to = visibleIds.indexOf(targetId);
  if (from < 0 || to < 0) {
    return selected.includes(targetId) ? selected.filter((id) => id !== targetId) : [...selected, targetId];
  }
  const range = visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1);
  return [...selected, ...range.filter((id) => !selected.includes(id))];
}
