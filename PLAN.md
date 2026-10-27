# Personal Reddit reader — implementation plan

## Current scope and next stage — 27 October 2026

This section records the latest user decisions and takes precedence over older
planning below. This round implements the combined Media filter and rechecks
live archive fetching. The additions below are planned, not implemented in this
round. Keep the app a compact, on-demand local web reader.

### Completed in this round

- Media combines Image and Video posts, including accepted discovered media,
  without duplicate cards for posts containing both. It hides body previews but
  retains titles, discussion links and Copy local path. Source/search filters
  and pagination compose with it; individual Image/Video filters remain.
- Both the previously failing exact archive request and a minimal documented
  request returned HTTP 200. The real app pipeline saved 161 AskHistorians posts
  across three pages, with zero parser omissions and persistence verified after
  reopening. Five total live archive requests, each paced at least five seconds
  after the previous response; no Reddit requests.
- Remove the unnecessary, undocumented meta-app query parameter. Its presence
  did not reproduce the previous failure; removal is not claimed as a fix for
  the earlier HTTP 500. Keep only documented search parameters.
- Historical post coverage and media availability are separate gaps. A broad
  oldest/newest span does not prove continuous coverage. Interrupted jobs stay
  unfinished; unavailable media does not imply that the post itself is missing.
- Resume retains unfinished history checkpoints and retries pending/failed
  downloads, even when the same feed has known unavailable media. Inconclusive
  discovery and native-player timeouts remain retryable. Posts show orange
  Not downloaded / Partially downloaded pills with a reason; unsupported
  embeds retain their visible post and an explicit online original link.

### 1. Encrypted backup and restore

- Add explicit backup/export and restore in Settings. Include a consistent
  database snapshot, owned media, feed/history preferences, deletion exclusions
  and future read states. Exclude browser cookies/sign-in profiles from the
  portable library backup; use the destination's sign-in after restoring.
- Require password encryption using an established authenticated-encryption
  format and password-based key derivation. Do not invent a cipher or store the
  passphrase. Select and document the maintained implementation before coding
  this stage. Stream large backups with bounded memory and disclose any
  temporary disk space needed for a consistent snapshot.
- Authenticate and validate the complete backup before replacing live data.
  Reject wrong passwords, tampering, truncation, unsafe paths and invalid
  schema/media without changing the current library. Confirm replacement,
  quiesce collection, stage the restore and retain a rollback copy until success.
  Restoring must never start collection automatically.
- Verify encrypted round trips, corruption, large files, interruption, disk/cap
  failures and preservation of deletion exclusions.

### 2. Viewport-based read tracking

- Add persistent local read/unread status and All / Unread / Read filtering.
  Reading is local to Collector and does not interact with Reddit's account.
- Ordinary cards must be fully shown in the viewport while the page is visible
  and unobscured. A provisional one-second dwell avoids marking a card during a
  passing scroll. For cards taller than the usable viewport, track visible
  coverage until every part has been shown; one visible edge is insufficient.
- Media/layout changes, background tabs, modal overlays and clipped cards must
  not cause false reads. Keep visible unread results stable until the user
  refreshes/changes the filter, rather than removing cards under their pointer.
  Include a manual read/unread override.
- Verify restart, fast scrolling, tall cards, media resizing, hidden tabs,
  overlays and filter changes. Store read state independently of observations
  so later live/archive updates do not reset it.

### 3. Search scopes

- Add Title / Body / Both, defaulting to Both. Body means the saved post body.
  Compose with subreddit, media, read status and pagination.
- Search the accepted reader-visible content, including live/archive body
  fallback. Never search a removed body or expose superseded archive text.
  Handle literal input, Unicode and phrases predictably. Evaluate an index
  against realistic library sizes before choosing full-text syntax; ordinary
  searching must not require a query language.
- Verify scope-specific matches, provenance, redaction, pagination and large
  libraries. Preserve filters against delayed responses.

### 4. Storage breakdown and selective cleanup

- Show space by subreddit and media type. Separate shared physical files and
  global database allocation so totals do not double-count shared media.
- Preview affected posts/files and estimated reclaimable bytes. Reuse confirmed
  post deletion and per-feed clearing semantics; preserve shared files while
  other posts own them, and preserve deletion exclusions.
- No automatic eviction or history pruning. Media-only eviction needs a
  separate explicit design: ordinary Sync currently redownloads missing files,
  so do not add cleanup that immediately downloads everything again.
- Verify sharing, cancellation, active downloads, capacity, reclaimed space and
  compaction failure reporting.

### 5. Complete galleries

- Traverse rendered gallery controls deterministically through the same paced
  browser, without a Reddit API, hidden state or AI extraction.
- Bind every slide to its post and establish the full ordered set. Persist
  slide progress, download all supported items and render an offline gallery.
  A preview or first slide must never count as a complete gallery.
- Handle repeated controls, unknown totals, mixed media, expired URLs, partial
  failure and Stop/Resume. Revisit the existing 20-reference safety bound;
  never silently truncate a larger gallery and mark it complete.
- Unsupported embedded providers remain labelled links until a provider has a
  separately verified, supported download path.

### 6. Easier launching

- Add a lightweight macOS launcher that starts the existing local server,
  opens the browser and offers Quit. Retain the CLI workflow.
- Detect a matching running instance and port conflicts. Respect per-clone data
  and overrides. Explain missing runtime/browser/media dependencies without
  installing anything silently.
- Quit stops jobs and preserves checkpoints. Verify launch/quit/relaunch,
  offline use, paths containing spaces and simultaneous isolated clones.

### Deferred: encryption of the live library

Encryption of stored database/media is explicitly deferred until the stages
above are resolved. Encrypted backups do not imply encrypted live storage.
Later design must cover unlocking/key lifecycle, SQLite journals, temporary
files, media playback and explicit conversion of existing data.

Implement and validate stages incrementally; commit and push completed tasks
under AGENTS.md. Do not discard the current library or add prototype
compatibility layers as a shortcut.

## Earlier planning and implementation history

Revision 5, reviewed 30 September 2026; implementation status updated 22 October 2026. This replaces the larger desktop/request-orchestration design with the local web-app approach discussed by Codex and Claude Opus 5.5. Both completed a quick review: ready to start the bounded browser/storage feasibility work. Layout behaviour and historical reachability remain empirical checks.

The local React/Node/SQLite app now implements the browser-backed feed, filters, saved history targets, thread snapshots, bounded JSONL/Zstandard import, and offline media. Authenticated Classic Reddit extraction was exercised on two distinct 25-post listing pages and a 37-comment thread. The collector uses JavaScript-disabled rendered HTML and suppresses nonessential resources; CSS establishes rendered visibility. See [evidence](FEASIBILITY.md) and [run instructions](README.md). Historical reach is still bounded empirical evidence, not a completeness claim. The latest requested Opus implementation review could not run because its Claude OAuth session expired; do not treat the older planning reviews as a review of this implementation.

## 1. Required behaviour

- One personal reader, with its own visible browser and persistent Reddit sign-in. The user signs in manually, including MFA.
- Configure multiple subreddits. Explicit Refresh populates a merged newest-first feed; no scheduled scraping or automatic collection on startup.
- Filter the compact dark feed by subreddit, text search, Text, Image and Video. Calendar history presets (1/3/6 months, 1/2/3/5 years and All time) default to one month per source; expansion triggers checkpointed backfill and contraction never prunes; the From/To reading filters were removed at the user’s request. A dedicated Feeds page owns subscriptions, confirmed removal, per-source successful refresh timestamps and individual/all refresh/stop controls. Link/Unknown are honest fallback categories, not inferred from article thumbnails.
- Read stored posts and explicitly saved discussions in one offline feed. Post selection, summaries and digests are out of scope.
- Reddit collection uses browser navigation and structured rendered DOM extraction. No direct Reddit API, `.json`, hidden hydration/component state, text response-body harvesting, screenshots or AI navigation/selector repair. The requested binary media downloads are a separate exception: DOM-observed image/file links and the normal player’s observed CDN DASH-manifest/MP4 URLs are cached locally through the shared request queue, with no guessed media endpoints.
- Adding a subreddit and its Feeds row offer 1 month (default), 3 months, 6 months, 1 year, 2 years, 3 years, 5 years and **All time (as available)**. Display stored counts and oldest/newest observed dates per source, with source and completion limitations. Preserve unfinished catch-up/history after pauses, later refreshes and restart. Deep history is in scope.

## 2. Small application architecture

Local React UI -> Node/TypeScript server -> SQLite and a Playwright collector. One application process; separate modules rather than services, Electron IPC or a general crawler framework.

- Bind the server to loopback only. Validate Host/Origin and use a per-launch secret for state-changing local endpoints; never expose credentials or profile data through the UI.
- Playwright owns one visible persistent Chromium/profile. No use of the user's everyday profile. One automation tab; reader tabs never receive automated collection actions.
- SQLite is the only work/progress authority. Use short transactions and prepared statements. Choose the SQLite binding against the pinned Node runtime; the local Node runtime exposes `node:sqlite`, which remains experimental at that installed version.
- A bounded asynchronous file importer may run alongside the browser collector. Both use the same short-transaction repository. Introduce a CPU worker only if measurements show unacceptable UI stalls.
- App-owned profile/database belong in the OS application-data directory, with an override for isolated tests. Secrets stay in environment/OS credential storage, outside the repository, logs and model input.

## 3. Browser feasibility before relying on an extractor

Test classic (`old.reddit.com`) and current Reddit layouts. Inspect actual attached, rendered post/comment elements, normal pagination controls, timestamp attributes and media evidence. Choose one successful adapter initially; do not build a speculative fallback for both layouts.

Classic is the implemented adapter, with saved login, validated IDs/creation times, actual Next navigation, a 37-comment thread and app restart persistence verified on the bounded Python sample. Live image/video-community evidence and the deepest reachable listing date remain to be measured; URL/media rules also have local fixture coverage. Never assume a historical 1,000-post cap applies to the browser or estimate throughput from an assumed page size.

If login/access is challenged, show the dedicated browser and pause for the user. Do not evade restrictions or silently collect anonymously. If live access cannot be verified, preserve the working foundation and report the unsupported scenario; do not claim the collector is compatible.

## 4. Extraction and identity

- Read rendered text, links, media elements and a tested scalar attribute allowlist on attached rendered hosts. Offscreen attached rendered cards are eligible. Exclude hidden/inert templates, scripts and skeletons. If the chosen layout uses open Shadow DOM, traverse it explicitly and test representative structures.
- Normalise IDs to `t3_<id>` and `t1_<id>`. Canonicalise and validate Reddit paths against IDs/subreddit. Outbound post links are metadata, not crawl targets.
- Live post acceptance requires ID, matching subreddit, title, canonical link and a reliable absolute creation time. Preserve actual timestamp precision; minute precision is allowed with stable ID tie-breaking. Relative labels alone are not exact timestamps. Missing/ambiguous dates are disclosed omissions, not guessed instants.
- Comment acceptance requires ID, containing post ID, text/availability marker and parent or explicit unresolved-parent state. Missing ancestry stays unresolved. Keep loaded ancestors for discussion context.
- Media rules are programmatic: explicit rendered type/media evidence or tested URL classification. A thumbnail/avatar alone does not establish Image. Categories may overlap with meaningful post body text; Unknown remains valid.
- Missing optional fields do not erase previously observed text/media. Explicit removal/deletion overrides affected stored text . Author deletion alone does not delete surviving text.
- Layout failure is distinct from an explicitly empty listing. Collect valid records despite omissions, but disclose incomplete extraction. No runtime AI repair.

## 5. Collection concurrency, pacing and budgets

One automated website operation globally across every subreddit, Refresh, history and thread reading. No parallel prefetch tabs, account rotation, proxies or stealth mechanisms.

Proposed starting values, to tune conservatively with evidence (not a published Reddit allowance):

| Control | Initial policy |
| --- | --- |
| Page navigation / visible Next | Wait at least 10 seconds after the previous load is ready before another navigation |
| Load-producing scroll/expansion | At least 5 seconds between automatic load actions, plus bounded readiness checks |
| Browser HTTP requests | User-requested cap: one request at a time, then at least 5 seconds after response readiness before the next dispatch, including redirects and page resources |
| Plain DOM extraction | No artificial delay; collect the current rendered batch before advancing |
| Readiness/navigation waits | Bounded 15-second element / 180-second paced page-load waits and 30-second response-header waits; no unbounded network-idle wait |
| Fresh Refresh | 15 minutes browser-work budget; time exhaustion pauses remaining targets |
| Deep-history session | Up to 60 minutes browser work, displayed; explicit Continue allocates another session |
| Scheduling slice | Up to 10 minutes on one source before servicing queued explicit Refresh/thread work |
| No progress | Three bounded attempts without new page/content evidence -> pause with reason |

The same action limiter covers all automated Reddit actions. Following the user's request-limit warning, a separate browser-wide request queue also releases HTTP requests at least 5 seconds apart. This includes redirects, scripts/assets, fetches and requests from owning frames/workers. A local browser fixture verifies these paths; service workers and network WebSockets are disabled in this diagnostic mode. The cap also affects manual sign-in loading and may make it slow. Record observed/intercepted/released/aborted counts; never equate two navigations with two HTTP requests. No live retry after the warning. All deliberate waits/replay count toward browser-work budgets; human-intervention time does not. Status codes and rate-limit headers may be observed for operational feedback only, never response bodies for content.

Stop account-wide automated browsing on 429, a block/challenge, or lost login. Honour Retry-After when supplied as a minimum cooldown and require explicit revalidation/Resume. Do not repeatedly retry a blocked state. A bounded transient transport retry may be considered only within the active budget; no automatic work resumes after application restart.

Local file imports do not use this website limiter because they make no network calls. Automatic third-party archive access, if selected, gets one serial limiter based on that source's documentation/reset headers.

## 6. Refresh, catch-up and deep history

1. Adding a source creates its requested history target and first schedules a current head scan so the feed is useful immediately.
2. Refresh checks each selected source's head serially. Freeze the attempt's upper time T. Create its since-last-requested-boundary target and advance that requested boundary in the same transaction. Requested boundary is scheduling metadata, not coverage proof.
3. Retain a small list of unfinished targets per subreddit: kind, lower/upper goal, saved continuation, counts, omissions and reason. Later refreshes never replace older unfinished targets. A single known post or page of stored IDs cannot close an older missed interval.
4. After heads, continue one source backwards in consecutive committed batches, preserving its current tab position. Switching sources may need replay if the layout lacks stable visible pagination; budget/disclose that cost.
   Within a Refresh, remaining time serves unfinished catch-up within its 15-minute budget. As-far-as-available runs in an explicit deep-history session (60-minute budget), triggered by choosing that option when adding a subreddit or by Continue; ordinary Refresh does not silently start it.
5. Date targets stop by an explicitly recorded inferred boundary or observed end. Proposed boundary: five distinct ordinary non-pinned/non-promoted cards strictly older than the lower bound, including a post-advance batch, with no eligible unknown-time card between them. Rounded timestamps use their precision intervals and overlap; never fabricate exact ordering at a boundary. Promotions/pins do not advance the streak.
6. As-far-as-available has no lower date bound. Continue within the session budget until actual listing exhaustion, a source limit, error or Pause. A budget stop means unfinished, never reached-the-end.
7. Save a browser-rendered Next link only after its real behaviour is verified; no invented cursor/query parameters. Restore and revalidate source/sort/identity on Resume. If continuation redirects/repeats or vanishes, replay/seek only within budget and label uncertainty; no guaranteed continuity from a scroll offset.
8. Progress shows collected count, oldest observed date, selected target and reason. Historical discoveries appear in the same feed through date/source filters. No invented total, complete-down-to floor or archive-completeness claim.

Use one simple operation lifecycle: queued, running, paused, done, failed or cancelled, with an explicit reason. Saved targets survive terminal attempts. Continue starts a new attempt against remaining targets; Cancel removes the target while preserving collected content unless Clear is chosen. Shutdown interrupts and checkpoints where safe; restart shows interrupted/paused intent without browsing. Removed subreddits cancel their unfinished targets. Silent account changes stop collection; MVP supports one account and refuses an implicit data merge.

## 7. External history

Reddit archiving disables votes/comments where enabled; accessible archived threads remain ordinary readable permalinks. Discovery reachability is a different issue. Slower browsing cannot expose dates the listing no longer serves.

Arctic Shift is the candidate external source. It offers subreddit/date exports, historical files and a limited hosted API, with upstream Reddit API provenance and possible gaps/release lag. Current hosted Pushshift is excluded because its stated use is moderation/safety. Wayback and whole-Reddit monthly ingestion are outside the first app.

Direct Arctic Shift fetching is now explicit in the archive dialog: subreddit, inclusive UTC dates, and Fetch/Stop/Resume. Use the public archive API without Reddit credentials. Persist page content and cursor atomically, replay boundary timestamps, share five-second HTTP pacing with browser/media, honor service cooldowns and stop at storage capacity. No automatic startup collection or archive retries. A new archive subreddit is subscribed without starting a live scan. Retain file import for bulk archives and sampled comments.

Manual import supports a selected subreddit/date export in the actual verified format (JSONL and `.zst` after successful bounded-codec, window-limit and truncation tests). Stream bounded input/lines, backpressure and short database batches; never load the full file. File-imported posts enter the persistent media backlog for the next explicit feed sync; direct archive fetching saves each page’s supported media before advancing. Display storage use, record/input budgets and omissions. Detect common input changes; different files/import attempts have distinct provenance. Initially restart interrupted compressed imports from the beginning and deduplicate rather than implementing seek indexes or repeated full-file prehashing. Do not present mixed or incomplete imports as a single complete snapshot.

Archive posts require normalised ID/subreddit/title/valid creation time, with supplied-and-path-checked or derived/unverified links. Optional comments are imported for selected post IDs with their parent relationships and source/export identity. Marker text (`[deleted]`, `[removed]`) and explicit source deletion metadata are availability states, excluded from available post/comment text. Live deletion tombstones cannot be undone by an archive import; a later verified live reinstatement is distinct.

Store source, original creation time, capture/retrieval time (unknown if absent), import/observation time and export identity. Live and archive observations remain separate; imports never overwrite current live text/field clocks or advance live tracking boundaries. File exhaustion proves only the selected input was processed. Its earliest/latest records do not prove every intervening post exists. Imported comments and live comments never become one apparently point-in-time discussion.

## 8. Offline reading

- Keep one combined feed with subreddit, media and text filters. No post selection, AI summaries or digests.
- Thread reading remains explicit; deep history does not visit thousands of threads for comments.
- Save up to 100 initially rendered comments with loaded ancestors and the actual server-selected sort. Show source, sample size, omissions and read time without claiming an exhaustive discussion.
- Archive comments use deterministic chronological sampling and retained ancestors. Enter up to ten post IDs in the archive dialog; no feed selection controls are needed.

## 9. Persistence and verification

Small schema: settings/subreddits, logical posts, source observations, unfinished targets/scan attempts, thread snapshots/comments. No mirrored queue or multi-request budget-ownership ledger. Retain content until Clear (subject to source conditions), show database size; no per-request TTL/pinning subsystem.

Commit content, counters and continuation together. Dedup by identity; do not inflate counts on replay. Clear cancels active work, increments a storage generation and rejects late browser/import callbacks. Persist only minimal diagnostics; no cookies, credentials, full authenticated HTML  in logs. Keep observed-deletion tombstones while the namespace is retained.

Meaningful tests: extraction against real sanitised DOM structures; invalid timestamps/media/ancestry; cross-source dedup/deletion; pause/restart without abandoning targets; batch/checkpoint atomicity; limiter shared across operations; input truncation/changed file/resource bounds; Clear rejects late results. Do not create tests that only mirror implementation.

Delivery order:
1. Runnable browser/session/DOM feasibility probe and storage/pacing foundation. Record actual evidence, especially current login, media fields, pagination/recovery and history depth.
2. Small local web UI, source settings, Refresh/filtering, honest progress and resumable history. No supported live compatibility claim before gate 1.
3. Selected archive export import and optional historical comments; test real format/resource/coverage handling.
4. Offline media, saved discussions and reproducible local launch instructions.

## 10. References and review record

- [Playwright persistent browser profiles](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- [Reddit Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- [Reddit community settings and archived posts](https://support.reddithelp.com/hc/en-us/articles/15484546290068-Community-settings)
- [Arctic Shift project](https://github.com/ArthurHeitmann/arctic_shift), [download tool](https://arctic-shift.photon-reddit.com/download-tool), [API limits](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md)
- [Node SQLite](https://nodejs.org/api/sqlite.html), [Node streaming](https://nodejs.org/api/stream.html)

Revision 4 received a fresh full Opus review and two follow-up checks (session `09dfe4e0-3cc7-419c-8eec-d10bf8e454d6`). The simplification discussion had two Opus 5.5 rounds (session `091c2899-ef27-47c9-bcc5-d86a9cbb9738`): agreement on web UI, serial browser/shared pacing, concurrent local imports and one tested layout. We rejected unverified listing-size/throughput claims and contiguous-history guarantees. The user subsequently confirmed web UI and retained As-far-as-available.

Codex self-review of revision 5: required features retained; web process replaces Electron; keep all unfinished targets; deep history/source reachability distinguished; no numeric delay represented as permission; archive acquisition preference left explicit and disabled by default; live compatibility stays a measured gate.

Quick Opus 5.5 review: actual model `claude-opus-5-5`, session `61005234-4a80-40c2-9318-a0a6cf17259e`, reviewed input SHA-256 `0cf71183d706d12707daa9eb541d6a283abc5db39fd2b85ec3435bda1ae4cefa` (before this header/review-record and requested budget clarification). Verdict: ready to start, no blocking contradictions or missing required features. Its one optional clarification separating Refresh and deep-session budgets is incorporated. Initial feasibility runtime: Node 25.3.0 with `node:sqlite`; its experimental status is recorded rather than hidden. No app completion or live compatibility is implied by planning review.

### Inline media update (22 October 2026)

Feeds shows inline timestamp labels, newest before oldest with full timestamps, and an actual Fetch/Continue history button. Refresh and history syncing save supported images/video before moving to deeper listing pages, automatically expanding native players when necessary. Existing and imported media backlogs are included. Reading or scrolling posts only reads local status/files; there is no per-post Load media action. A persistent ledger survives stop/restart and reports ready/pending/failed/unavailable counts per feed. Continue can finish media even after the history target is complete. Restart never starts network work automatically.

CDN and browser dispatch share one completion-based five-second queue across browser restarts and one 120-request sync budget. Stop cancels discovery/downloads; failed files wait for the next explicit sync. Connectivity loss pauses the whole sync rather than attempting every remaining file. The gate blocks observed native-player manifest/MP4 requests before dispatch; the app downloads the validated file URLs named by the bounded DASH manifest (main video up to 720p, plus explicit audio), and FFmpeg combines separate video/audio tracks locally. No Reddit API or hidden-state extraction is introduced. Local playback supports byte ranges. CDN 403/429 pauses all collection; redirects are refused. Deletion/clear/generation checks prevent serving removed or late content. Files have bounded per-file sizes and a configurable combined database/media cap, default 10 GB, without automatic eviction; capacity or disk exhaustion pauses. Complete gallery traversal was not available in the tested layout, so galleries are explicitly unavailable rather than falsely marked complete after one slide. External embedded providers may also be unavailable.

### Storage settings and navigation (22 October 2026)

All subreddits is the one combined-feed navigation entry; remove the duplicate Posts link. Settings exposes Max stored size in GB (10 GB default), persisted in SQLite. Sidebar usage is database allocation plus saved media/cache metadata divided by the cap, with the actual percentage and both sizes visible. Browser-profile, journal and temporary working files are excluded. Check capacity before collection and transaction commit, on media response headers/stream chunks and before publishing a completed file. Oversized batches roll back atomically with their checkpoints; a failed download leaves no published/partial file. Imports and saved discussions follow the same content limit. Lowering the cap preserves data and may display usage above 100%. Increasing it never starts work automatically. Settings, Stop and Clear remain usable at capacity; Clear compacts freed database space.


### Review fixes and verification (23 October 2026)

Fix confirmed findings rather than leaving them as review notes: replayed listing batches cannot advance completion; discovered media has separate evidence without promoting archive text to live provenance; denied native manifests require rediscovery on explicit Continue; compaction failure cannot prevent media cleanup after Clear; orphan cache files count toward capacity; delayed polls/feed requests cannot replace the current filter. Pending-media wording now distinguishes a running queue from a stopped feed.

Additional verification found moderator-removed Classic OPs without data-fullname. Bind the unique visible removed OP to the validated thread URL and explicit removal marker, preserve visible comments and redact the removed post. Bound aggregate imported-comment sample characters and await aborted imports before database shutdown. Recheck workflow behavior in real Chrome against isolated local fixtures; keep live checks bounded and recorded in FEASIBILITY.md. Galleries and unsupported external embeds remain explicitly unavailable.


## Direct archive fetching — 23 October 2026

The primary archive UX is a subreddit/date-range form, not a manual export/upload. Jobs persist counters, boundary IDs, cursor, media phase and cooldown in SQLite. One archive job runs at a time alongside the existing single browser worker, with all HTTP dispatch sharing the completion-based five-second queue. Stop/Resume, scoped/global Clear, Remove feed, deletion exclusions and restart behavior apply. No arbitrary total input/record ceilings; retain per-response/record/decoder-memory guards and the configured storage cap. Bulk-file import remains a secondary path. Live Reddit head/history timestamps are never advanced by archives.
