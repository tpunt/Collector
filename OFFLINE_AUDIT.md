# Offline-content audit — 27 October 2026

Scope: complete post text and every attached file the collector can obtain from
Reddit or the selected archive. Discussions remain on demand. The previously
agreed online-player exception for YouTube/Vimeo remains explicit.

## Implementation gaps found and resolved

| Gap | Resulting behavior |
| --- | --- |
| Native galleries were blanket unsupported | Traverse real controls, verify every slide against the source order/count and use the rendered full-size links. Save captions and the complete file list before downloading. |
| Listing previews could count as saved text, or bodies could remain absent | Sync fetches the full body. Observed updates get durable pending/fetching/ready/failed state, including when an older body is already cached. |
| Body hyperlink destinations and inline-image originals could be lost | Retain rendered link destinations in saved text and prefer the linked original over its preview. |
| Complete archive gallery/video metadata was ignored | Use explicit ordered gallery URLs and owned native-video manifests directly; incomplete metadata falls back to browser discovery. |
| Media references silently stopped at 20 files; the queue could strand files after 40 | Remove truncation and drain bounded batches through the shared request budget. A failed early file cannot strand later batches or retry itself automatically. |
| Fixed image/video size caps made retrievable files permanently unavailable | Stream under the user's combined storage cap. Capacity pauses remain resumable. |
| All media redirects were discarded | Follow validated HTTPS public-file CDN redirects, pace/count each hop and reject unsafe destinations or cycles. |
| Parser/discovery failures could become permanent gaps | Inconclusive discovery/manifest reads remain failed work. Old gallery, file-size and manifest implementation-limit states are requeued without reopening genuine missing-file gaps. |
| Refresh or a discussion read could replace full gallery evidence with previews | Preserve the complete file list and its ordered collection metadata. |
| A saved preview could hide incomplete gallery discovery | Expose incomplete discovery, text progress and saved/total file counts in the UI. |

## Persistence and recovery

Version-one libraries receive one additive transactional upgrade for the text
ledger. Existing content, media ownership, settings and exclusions are preserved.
Previously unverified live text is pending; an old success claim cannot override
that work. Unknown/prototype schemas are still rejected. Startup never initiates
website traffic. Stop, restart, deletion, Clear and capacity failures retain or
discard work according to their existing ownership/generation rules.

## Verification

- All 141 unit tests and 44 local Chrome/API/network integration tests pass,
  along with type checking, production build and Git whitespace checks.
- Live DOM traversal and download of all six full-size gallery files from one
  actual post; all six decoded from local app URLs after restart. Widths ranged
  from 1,864 to 4,608 pixels, rather than the listing's 108-pixel previews.
- Local tests cover two/25-slide collections, duplicate files, captions, unsafe
  links, stalled discovery, interrupted downloads, a 65-file post, mixed failures,
  files above the old size limit, full text, updates and offline viewing.
- The reading-only QA server disabled both website navigation and new media
  downloads. It displayed the complete gallery and full-text fixture with zero
  collection requests. Runtime evidence remains in the ignored QA directory.

## Explicit source boundaries

- Removed/deleted/private content, genuine missing files and source access denial
  cannot be promised offline. Blocks stop collection; no bypass is attempted.
- History is limited to what Reddit and the archive actually expose. Stopping,
  budgets or incomplete parsing are unfinished work, not proof of missing content.
- YouTube/Vimeo players require internet and retain Not downloaded. Other
  unimplemented external providers retain an original link and an unavailable
  explanation; these are not advertised as offline downloads.
- Linked external articles are not downloaded as whole websites. Post text and
  link destinations are retained. On-demand discussions still disclose their
  initially rendered comment sample and omitted branches.
- Read tracking, encrypted backups, indexed search scopes, confirmed storage
  cleanup and a macOS launcher are implemented. Live-library encryption remains
  deferred. These additions do not change the source availability boundaries above.
