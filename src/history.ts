import type { HistoryTarget } from './store.ts';
import type { Listing } from './extract.ts';

/** Conservative evidence of a date crossing, never a claim of contiguous coverage. */
export function advanceBoundary(target: HistoryTarget, listing: Listing, seenBefore = false) {
  const boundary = structuredClone(target.boundary);
  const repeated = seenBefore || boundary.lastSignature === listing.signature;
  boundary.repeats = repeated ? boundary.repeats + 1 : 0;
  boundary.lastSignature = listing.signature;
  let contributed = false;
  if (listing.unknownTime) { boundary.olderIds = []; boundary.batches = 0; }
  else if (!repeated && target.lowerMs !== null) {
    for (const post of listing.ordinary) {
      if (post.createdMs + post.precisionMs <= target.lowerMs) {
        if (!boundary.olderIds.includes(post.id)) { boundary.olderIds.push(post.id); contributed = true; }
      } else { boundary.olderIds = []; boundary.batches = 0; contributed = false; }
    }
    if (contributed) boundary.batches++;
    boundary.olderIds = boundary.olderIds.slice(-20);
  }
  const crossed = !repeated && target.lowerMs !== null && boundary.olderIds.length >= 5 && boundary.batches >= 2;
  const end = !repeated && listing.next === null;
  return { boundary, done: crossed || end, stalled: boundary.repeats >= 2,
    completion: crossed ? 'date-boundary' as const : end ? 'listing-end' as const : null,
    reason: crossed ? 'Date boundary inferred across two batches; coverage may contain gaps' : end ? 'Reached the end served by this listing; older content may exist in archives' : null };
}
