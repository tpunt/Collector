# First milestone evidence — 30 September 2026

The plan is ready to implement. This milestone supplies runnable storage/pacing modules and a bounded DOM probe; it does not establish a supported Reddit extractor.

- Node 25.3.0, installed Playwright 1.63.0 (locked dependencies). Built-in `node:sqlite` is experimental in this runtime.
- The Playwright Chromium download failed repeatedly with an installer directory-lock error. No dependency internals were patched. Installed Google Chrome successfully launched under Playwright in a fresh, app-owned profile using `--channel chrome`.
- One public, headless inventory attempt for `r/python`: `old.reddit.com/r/python/new/` returned 302 to `/login/`, then HTTP 403. No post hosts, absolute times or Next links were available. The limiter paused; the modern layout was not attempted after the block. No feed was collected.
- Authenticated profile reuse, post/comment extraction, media categories, pagination/restart and actual reachable history depth remain unverified. The next live check requires manual sign-in/access in the dedicated visible browser. No AI or bypass technique is used to recover access.

Run the visible check from an interactive terminal:

```sh
npm run probe -- --channel chrome --login --subreddit python
```

If Reddit blocks that initial navigation, the browser stays open for manual inspection/sign-in; the probe remains paused and prints its result when Enter is pressed. A later run is explicit. The probe never asserts programmatic session validation from a cookie or a login redirect.

Codex self-review found no planning blocker. Storage tests exercise real SQLite transactions/restarts; limiter tests exercise shared serialization, readiness spacing, blocked queues and explicit cooldown/revalidation. Clear also retains minimal known-deletion protection for followed namespaces, without retaining their bodies. These checks do not substitute for live layout evidence.

Quick Claude Opus 5.5 code review: actual model `claude-opus-5-5`, session `095782a0-c33c-423a-b559-d0962b4cc496`, input SHA-256 `acdbdc25b3aa9408b9c2691a0dabcf5f2c0aca8070aa4b26dbbdee7f6ee061bf` before review fixes. Verdict: ready for feasibility after fixing login-pause reporting. That fix is incorporated, along with separate headless/manual-login profiles, clear unknown-subreddit errors and a bounded DOM inventory. Codex also checked that a later partial head observation cannot reinstate a removed body without explicit live availability evidence.

## Request-limit warning and correction

The visible sign-in probe was launched later and remained waiting for user input. The user reported Reddit's too-many-requests message; Codex immediately cancelled the probe and closed its browser. There had been two app-initiated navigations across both live runs (head listing and login), plus the first run's automatic redirect. Browser-generated HTTP requests were not counted in those versions, so the historical total is unknown. No subsequent live Reddit request was made for this correction.

The previous action limiter did not limit the HTTP resources a page loads. A browser request-stage gate now releases at most one intercepted HTTP request per five seconds globally, independently of the existing 10/5-second action pacing. A local-only Chromium fixture verifies redirects, scripts, fetches, frames, worker requests and multiple tabs; shortened intervals in that integration fixture avoid hitting any website. A separate deterministic queue test verifies the production five-second interval. Request counts appear in completion/cancellation reports. Any block/429 also stops pending requests; no automatic retry or website restart after this warning.

## Sign-in attempt — 22 October 2026

The user reached the sign-in form after a long load, then reported Reddit's generic extensions/browser error. They also reported Chrome's `--no-sandbox` warning. The probe was stopped: one automated navigation, 58 browser-observed HTTP requests and 59 interception events, with 37 releases and 22 cancellations. Browser request events and interception events have different counts; these are operational observations, not a reconstructed server access log.

The installed Playwright launcher adds `--no-sandbox` unless `chromiumSandbox` is explicitly true. The shared launch options now enable the sandbox, and a local-only test inspects Chrome's actual arguments. Extensions were already disabled by Playwright. Reddit's generic message does not prove an extension or sandbox caused the rejection. Queueing all assets and authentication requests five seconds apart may disrupt time-sensitive sign-in; this remains a hypothesis. The user's request cap remains unchanged, and no additional live sign-in attempt is made as part of the sandbox fix.

## Authenticated session verified — 22 October 2026

The user subsequently authorised an agent-driven sign-in by supplying credentials. One login form submission was made using the native rendered inputs and button. Credentials entered through non-echoing stdin were kept out of project files and application diagnostics. No password was entered during the later verification run, and no cookies, hidden session state or response bodies were read for authentication evidence.

The first form-loading run made no submission because its username selector matched both a web-component wrapper and the native input. The corrected helper matched the native input, submitted once, and observed a redirect to the home page. That redirect alone was not treated as proof of authentication.

A subsequent browser restart reused the app-owned profile. On `old.reddit.com/r/python/new/`, the visible account header and its profile link both matched the expected identity, confirming sign-in and saved-session reuse. The listing exposed 25 post hosts, 26 absolute-time elements and one Next control. These are observed DOM counts, not a completeness claim or a validated creation-time/media/comment extractor. Actual Next navigation, comment/media extraction and reachable historical depth still need bounded tests.

The five-second HTTP cap stayed enabled throughout. Request-gate counters for these three runs:

| Run | Form submitted | Intercepted | Released | Cancelled |
| --- | --- | --- | --- | --- |
| Initial form readiness | No | 83 | 71 | 12 |
| Corrected sign-in | Once | 98 | 64 | 34 |
| Saved-session verification | No | 31 | 16 | 15 |

The browser was closed after verification. Passwords were not added to application settings, source or fixtures. Remaining browser work can use the saved session without retaining the supplied password.

## Web app implementation and bounded live checks — 22 October 2026

Classic Reddit is the implemented adapter. The collector disables page JavaScript and suppresses scripts, images, media, fonts, XHR/fetch, pings and miscellaneous assets before dispatch. CSS remains enabled so extraction can reject hidden elements. Interactive login uses the same saved profile with JavaScript enabled and normal resources still paced.

The structured extractor accepted 25 posts per observed page with zero omissions in the successful Python checks. Creation times were distinguished from edited timestamps. It followed the actual rendered Next URL to distinct older content, then read one thread containing 37 comments with resolved parents. No screenshots, hidden state, Reddit JSON/API endpoint, response body or AI was used to collect content.

Early checks read before HTML readiness, then pagination timed out because queued resources from the preceding page remained. Collection now waits for the paced page load before following Next (bounded at 180 seconds). These failures were not retried automatically by the application; development reruns were explicit and bounded.

| Live check in this implementation session | Released HTTP requests | Outcome |
| --- | ---: | --- |
| Initial Classic DOM readiness inspection | 2 | Read too early; browser closed |
| Corrected DOM readiness inspection | 2 | Structured attributes and Next observed |
| First pagination extraction check | 10 | First 25 posts validated; Next timed out; browser closed |
| Corrected listing/listing/thread check | 16 | Two distinct 25-post pages and 37-comment thread validated |
| Add & collect through the running web UI | 15 | 75 posts stored; zero omissions; inferred requested date crossing |
| Read discussion through the running web UI | 13 | 37 comments saved, actual best sort, resolved parent IDs |

These recorded checks total **58 dispatches**, excluding earlier sign-in/probe runs documented above. Counts are interception releases, not reconstructed Reddit server logs or API calls. Every run retained five-second dispatch spacing. Before the final app checks, a local-only network fixture exposed delayed arrivals bunching at the server. The gate was strengthened to wait for response readiness and then five seconds before the next request. It observes only operational lifecycle/status metadata, never response bodies. Redirects and owning-frame worker requests require response-stage continuation to avoid deadlock; the local fixture verifies those paths. The final app checks used that stronger policy and saw no 429 or access pause.

The running app stores 75 real r/Python posts and one 37-comment live snapshot. This is a small empirical sample, not proof of deep listing reachability or complete history. Media URL classification and hidden/invalid-card handling are tested with local fixtures; live image/video communities have not yet been sampled. The thread's Top control was hidden with scripts disabled, so extraction records the actual visible best sort rather than following a hidden link.

Local verification covers real SQLite transactions/restarts, generation and deletion safeguards, conservative date boundaries, archive provenance, streamed JSONL/Zstandard handling, complete compressed-frame checks, oversized decoder windows, UTF-8/truncation failures, citation validation, provider cooldown/cache behavior via stub, local API origin/token checks, real browser UI filtering/uploads, mobile overflow, sandbox flags and actual paced network requests. Real paid summary calls remain untested and disabled until provider/model/key configuration.

The latest requested Opus 5.5 implementation review **did not run**: the installed Claude CLI reported `OAuth session expired and could not be refreshed` with no model usage. Codex reviewed and tested the implementation; earlier successful Opus planning/foundation reviews do not cover this code. One automatic permission-review attempt timed out before execution; a later approved attempt reached the CLI and established the authentication failure. No credentials or browser profile data were sent for review.

A final application restart retained all 75 posts and the 37-comment discussion, with zero website requests after restart and no browser UI errors. The oldest observed post in that bounded scan was 30 September 2026, 12:34:35 UTC. The app was left running and idle at `http://127.0.0.1:3210`. Final checks: TypeScript check/build, 30 unit/storage/streaming/provider tests and five local browser/API integration tests passed. Media filters include explicit Reddit gallery, direct image/video, YouTube video and Vimeo video URL rules; a channel link remains Link.

## Compact dark UI and multiple feeds — 22 October 2026

The user requested a dark theme, higher information density, removal of the From/To reading filters and marketing copy, and a dedicated subscription-management page. These changes are implemented. Feeds now shows per-subreddit stored counts, last successful refresh, current/queued/stopping state, individual/all refresh, Stop, Add feed and confirmed removal. A successful newest-page checkpoint updates its refresh timestamp in the same transaction as the content; scheduling, failed/stopped attempts and older-page progress do not masquerade as a refresh. These timestamps persist after restart. Removing a feed keeps stored content/history, stops its work and excludes it from subscribed post queries.

A bounded live test added **r/aww**, which produced **25 posts: 20 Image and 5 Video**, alongside the existing 75 Python posts. Refresh all queued Python while Aww was already active, without duplicating Aww. After the first Aww page committed, its history work was stopped independently and Python continued to finish. Both successful refresh timestamps were visible; Aww retained a saved Next checkpoint and stopped state. The test released **16 HTTP requests**, still at the established five-second response-aware spacing, with no 429/access pause and no UI errors. Image filtering rendered all 20 expected image cards. The app was left idle rather than crawling Aww’s high-volume seven-day history.

Local tests exercise stopping active versus queued feeds, preserving checkpoint/timestamp state, unrelated feeds continuing, last-success atomicity and restart persistence, refresh selection scope, removal requiring explicit confirmation, the real confirmation dialog’s Keep/Remove paths, add/remove controls, dark styling, subreddit filters and mobile overflow. These local fixtures make no Reddit requests.

The final read-only UI checks also exercised the five saved video posts and retaining expanded pages across status polling. A polling-initialisation bug found during that check was fixed and covered by a browser regression test. The user’s existing in-app tab was reloaded into the new dark UI and opened on Feeds, showing both communities, their separate refresh times, stopped Aww history and completed Python refresh. Final verification for this revision: 34 unit/storage/scheduler/provider tests and eight local browser/API integration tests, plus TypeScript/build checks.

## Per-feed history windows and a real listing-end test — 22 October 2026

Implemented per-feed calendar presets: 1 month (default), 3 months, 6 months, 1 year, 2 years, 3 years, 5 years and All time. The picker is on each Feeds row and in Add feed. Expanding starts a saved backfill automatically; contraction stops wider work, keeps all stored content, and makes no new collection request. Preferences and checkpoints persist across restart. Feeds shows stored counts, oldest/newest dates, live/archive counts, known omissions and distinct selected-range/listing-end/paused outcomes. Page overscan is retained.

The deeper live test used r/Python, the saved login and the unchanged response-aware five-second HTTP limiter:

| Operation | Python posts stored after the operation | Oldest observed post | HTTP releases |
| --- | ---: | --- | ---: |
| Fetch one month from the saved September checkpoint | 125 | 11 September 2026 | 13 |
| Expand one month → three months (automatic backfill) | 300 | 5 July 2026 | 18 |
| Expand three months → All time, including fresh catch-up before older continuation | 954 | 23 February 2026, 12:30:54 UTC | 41 |

The All time run followed real visible Next links until Reddit served a final listing page with no Next link. Completion is recorded as **listing-end**, not complete lifetime coverage. No artificial 1,000-post bound was built into the crawler; this observed traversal accepted 954 distinct posts. No extraction omissions, 429 or access pause were observed. The three live phases released **72 HTTP requests** in total. Restarting between phases made no website request until the next explicit action.

This proves the website adapter can traverse and checkpoint an extended reachable listing. It also establishes the limitation: the tested Reddit listing did not expose older history beyond February 2026. All time in this app means what that browser listing serves; older lifetime coverage requires archive input and remains subject to source gaps. The importer exists, but automatic archive acquisition is not enabled.

Local tests cover the calendar choices/month-end/leap-year bounds, known-ID replay without premature stopping, one-month/three-month/all-time traversal through a realistic multi-page fixture, sparse ancient archives not moving browser progress, checkpoint reuse, persistent fresh-catch-up dependencies before older work, disconnected rolling windows after a long absence, and contraction preserving content without fetching. The current suite contains 39 unit/storage/scheduler/provider tests and ten local browser/API integration tests, plus TypeScript/build checks.

A final live contraction from All time back to one month retained all 954 Python posts and their oldest date. The request counter stayed at 41 before/after contraction and collection remained idle. There are 979 stored posts overall (954 Python, 25 Aww), plus the earlier 37-comment snapshot. Both feeds were left on the one-month default.


## Inline media and timestamp validation — 22 October 2026

Feeds now shows each timestamp beside its label, Newest before Oldest with full date/time, and bordered Fetch/Continue history buttons. Verified in the running local app, including the narrow layout.

The Aww test collection now has 53 saved posts (954 Python posts retained). Four direct image downloads were cached and displayed in the real feed. The native-video test used `t3_1xcihd9`: the initial resolver selected a low-resolution preview; the live check caught this and the corrected resolver uses the player’s observed DASH manifest. Post text remains rendered-DOM-only. Media manifest/file bodies are the explicit binary-media exception, never Reddit API or hidden post state. The manifest is bounded and parsed with fast-xml-parser; explicit video/audio BaseURL entries are validated against the owning CDN directory. Native preview and manifest/MP4 requests are suppressed before browser dispatch and downloaded through the shared paced queue.

The final native-video run recorded 20 browser releases plus three CDN requests (manifest, main video, audio), with no access pause/429. FFmpeg produced a local file containing H.264 video at 360 × 640 and AAC audio. Actual UI playback reached currentTime > 0 with no media error, duration 10.959833 seconds; playback ended normally. Local file playback did not issue CDN requests. Final job queue and media queue were idle.

Recorded releases across this media investigation: Classic listing/thread inspection 14; current-layout checks 2 + 3 + 2 (no usable media DOM); normal-player inspection 22 + 22; bounded Aww refresh 14; initial image/preview run 25; final manifest run 23. Each collector used the five-second request gate. Local automated tests make no Reddit requests. These are per-run recorded HTTP-release counters, not counts of UI navigations.

Validation: TypeScript check, production build, 45 unit/storage/limiter tests and 13 browser/API/network integration tests pass. The focused media regression also verifies pacing between manifest/video/audio/image requests, local byte-range playback, cache reuse, rendered gallery extraction and rejection of unrelated/hidden media. Screenshots: `/private/tmp/reddit-reader-timestamps-actual.png` and `/private/tmp/reddit-reader-inline-media-actual.png` contain real local app data. Gallery expansion currently collects rendered slides only; complete gallery traversal and external embedded providers are not claimed.

## Media saved by sync — 22 October 2026

Refresh/history work now includes a persistent media backlog. Reading posts and GET status/file endpoints make no remote download requests; per-post download/discovery mutation routes and the Load media button are removed. Existing missing media is included, even if the post history target is already complete. Known direct files within each batch are saved before slower browser discovery. Feeds reports media posts ready/pending/failed/unavailable; stopped/interrupted files remain pending for explicit Continue or Refresh. The browser and CDN share the same five-second completion-based queue and 120-actual-request session budget. Restart reconciles local cached files without starting network work. Files are retained without automatic eviction or an aggregate cache cap, with per-file bounds and a pause on disk exhaustion.

A live gallery investigation recorded 20 Classic browser releases, then 57 current-layout releases before its bounded navigation timed out. The current layout did not provide verified complete gallery traversal. A subsequent bounded backlog run recorded 21 browser releases before stopping. These checks were all paced; no bypass or API fallback was used. Galleries are now explicitly unavailable rather than treating a rendered first slide as a complete offline gallery. Unsupported-provider errors do not stop unrelated media; access/rate-limit failures still stop the entire sync.

The final bounded sync saved `t3_1xcj266` (The cute Bailey from our shelter) automatically while the app remained on Feeds, using exactly one CDN request and zero browser requests. The file is 85,689 bytes. The check stopped immediately after the first additional post became ready; Aww now has 7/53 media posts offline, with remaining work preserved. Local viewing does not fetch that file again. The app is running and idle at `http://127.0.0.1:3210`.

Validation: TypeScript check, production build, 52 unit/storage/workflow tests and 14 local browser/API/network integration tests pass. Workflow coverage includes more than one backlog chunk, native-video discovery, shared request budgets, interrupted restart/resume after completed history, per-file failures, connectivity loss, stop/clear and rejecting incomplete gallery coverage. Browser checks verify images/playable native video from local files, no remote requests on viewing/reload, and no per-post Load media control. Tests use local fixtures/stubs, not Reddit. Browser tests require the documented installed-Chrome channel (`REDDIT_READER_BROWSER_CHANNEL=chrome`).

## Storage cap and combined-feed navigation — 22 October 2026

Removed the duplicate Posts sidebar link; All subreddits is the combined feed, including on mobile. Settings now saves Max stored size in GB, default 10 GB. Usage includes the allocated database and saved media/cache metadata, excluding browser profile, journals and temporary working files. Sidebar shows both percent used and used/cap sizes. Capacity checks cover live batches/checkpoints, imported batches, discussions, summaries and media headers/streams/publication. Lowering the cap preserves posts and offline files; raising it requires an explicit collection action. Clear compacts the database.

Validation: TypeScript check, production build, 55 unit/storage/workflow tests and 16 local browser/API/network integration tests pass. New checks verify cap validation/authentication/persistence, rollback of oversized batches without advancing checkpoints, partial-file cleanup, offline-file preservation after lowering/restart, blocking collection before network requests at capacity, database space reclamation by Clear, sidebar percentages and mobile navigation. All tests use local fixtures/stubs.

The running app was restarted and Settings saved 10 GB successfully. Actual status: 3,971,205 bytes stored (0.03971205%, displayed 0.04%), all 1,007 posts retained, idle queue and zero Reddit/CDN requests in this app session. Screenshots: `/private/tmp/reddit-reader-storage-settings-actual.png` and `/private/tmp/reddit-reader-storage-sidebar-actual.png`.

## Review fixes and live verification — 23 October 2026

All six confirmed review findings are fixed: repeated pages no longer contribute to history completion (including repeated listing ends); media discovery has separate URL evidence without replacing archive text/provenance; native-video 403 failures persist rediscovery for explicit Continue across restart; a failed VACUUM reports a warning without skipping media cleanup; orphan/corrupt cache entries count toward capacity; delayed polls/feed responses cannot replace the selected filter. Media status now says whether it is downloading, queued in a running sync, unavailable, failed, or not downloaded while stopped.

Further review bounded aggregate archive-comment samples to four million characters with omission counts, and made shutdown await aborted imports. Successful discussion retries clear stale feed errors. Thread extraction selects the exact visible post rather than the first card, which may be unrelated or hidden.

Actual use exposed a moderator-removed Python OP (`t3_1xcdh70`) that renders a discussion but no post ID attribute. A bounded DOM diagnostic confirmed this specific Classic layout. The reader now accepts that case only with the matching thread URL, a unique visible unlabelled post and an explicit removal marker. The final live read saved **12 comments**, reply ancestry and the observed **best** sort, while marking the OP removed and hiding its body/media. The result survives restart.

The live Aww refresh fetched **25 new posts** (53 → 78) and automatically saved media for **14 additional posts** (7 → 21 offline) without opening those posts. Total stored posts: **1,032**. The actual app was also used to filter by subreddit/type/text, save the 10 GB setting, play the existing local native video (10.959833 seconds; playback advanced to 7.289763 seconds), and copy its exact local path. The native video reports no playback error and uses `/media/…`, not a remote source. The idle wording no longer claims an active pending sync.

Live checks made **78 actual Reddit/CDN requests in total across the bounded runs**: 39 in the initial refresh/discussion session, 13 in the selector retry, 13 in the public-DOM diagnostic, and 13 in the final successful discussion read. The shared five-second completion-based limiter remained enabled. No block/429 occurred and there were no automatic retries. The app was restarted afterward and left running idle; per-launch request counts reset on restart. Unfinished Aww history/media remain saved for an explicit Continue/Refresh.

Validation: **62 unit/workflow tests and 18 local Chrome/API/network integration tests pass**, together with TypeScript and the production build. Focused checks were repeated after the final stale-error and summary-mode changes. No Reddit requests or paid summary calls are made by these tests.

| Feature | Verification |
| --- | --- |
| Saved sign-in and identity checks | Actual Aww refresh and Python discussion read; account identity checked in the collector. Interactive sign-in was not repeated because the saved session works. |
| Multiple subscriptions, add/remove confirmation, individual/all refresh, Stop | Real Chrome against an isolated app with controlled listings; actual two-feed UI and Aww refresh also exercised. Removal preserves stored posts. |
| History presets/default/expansion/contraction/all time | UI and job fixtures cross month/year boundaries, resume committed checkpoints, catch a newer gap, reject repeats, preserve content on shrink and report listing exhaustion. No claim of lifetime completeness. |
| Older external history | JSONL and Zstandard fixtures, including older posts, comment ancestry, truncation, bounded samples, deduplication and interrupted shutdown. The UI streaming-upload path is exercised. Beyond Reddit's reachable listing, this still requires a user-provided archive export. |
| Text/image/video filters, search, pagination | Actual stored feed plus browser fixtures; delayed responses tested explicitly. Polling preserves loaded pages when content has not changed. |
| Offline media and local paths | Actual automatic downloads, video playback and clipboard path; fixture image/video/audio mux, byte ranges, reload without remote requests, cap failures, Stop/restart and expired-manifest recovery. |
| Thread reading and removals | Actual removed-OP discussion plus fixtures with hidden/unrelated cards and mismatched identities. |
| Summaries/digest | Real UI and server pipeline with a local provider stub, citation validation and cached output; unit checks also cover digest mode, stale results and provider cooldown. Paid provider remains unconfigured in the actual app. |
| Storage settings and Clear | Actual 10 GB save; isolated UI/API tests lower/raise caps and exercise confirmed Clear, including injected compaction failure, orphan cache files and no data pruning. |
| Dark compact UI/mobile | Actual desktop UI; real Chrome fixtures at desktop and 390-pixel width. |

Remaining product limits are explicit: complete gallery traversal and unsupported external embeds are unavailable; the browser cannot guarantee complete lifetime history; archive import is manual; summaries need a configured provider. These are not reported as verified supported features.


## Per-subreddit Clear — 23 October 2026

Added Clear data to each row on Feeds, with named confirmation and a Keep data cancellation action. It stops only that feed's queued/active work and matching importer. A transaction removes its posts and observations (including deletion state), comments/discussions, affected summaries and mixed digests, import records and refresh/history checkpoints. Subscription and selected history limit remain. Other feeds' content and work remain intact.

Cache ownership is tracked by subreddit, including superseded media references, and migrated from existing saved observations. Exclusive files and metadata are removed; files owned by another subreddit remain playable. Per-source revisions prevent late media/model results from restoring cleared data without invalidating other feeds' work. Aborted queued media does not make Clear wait for another feed's in-flight request. Clear still completes logical/file cleanup if database compaction fails.

The actual app's confirmation was opened and cancelled; all 1,032 real stored posts remain. No Reddit/CDN requests were made for this feature. Confirmed deletion is exercised against isolated local fixture data, including cancellation, preserved preferences, shared/superseded media, stopped imports, late summaries, active/queued syncs and mobile layout. Screenshot: /private/tmp/reddit-reader-clear-subreddit-confirmation.png.

Validation for per-subreddit Clear: TypeScript check, production build, 68 unit/workflow checks and 21 local Chrome/API/network integration checks pass (89 total).


## Persistent individual-post deletion — 23 October 2026

Added a trash button to each feed card and Delete post in the thread drawer, both behind a confirmation naming the post. It is explicitly local: no Reddit moderation/reporting action occurs. The transaction removes the post, observations, saved discussion/comment state, media ledger and all summaries/digests that include it. Other posts and history checkpoints remain intact. Files are removed only when no remaining post owns them, including sharing within the same subreddit and superseded media references. Existing observations are migrated into per-post media ownership.

A minimal persisted exclusion stores only post ID, subreddit and deletion time. Live batches and archive ingestion skip excluded IDs. Pages containing only excluded posts still advance checkpoints. Late discussion/media/model results cannot restore the deleted post. Exclusions survive application restart, per-subreddit Clear and global Clear. Active or queued work for that post is cancelled without stopping another post's work. Deletion remains usable at the storage cap.

Validation: 74 unit/workflow tests and 24 local Chrome/API/network integration tests pass (98 total), with TypeScript and production build. New coverage exercises confirmation/cancellation, feed and drawer actions, refresh/reload/import exclusion, persisted exclusions after both Clear actions, derived-summary cleanup, buffered imports, skipped-only history pages, late thread results, queued media, shared/superseded files and deletion at capacity. The real app's confirmation was opened and cancelled; all 1,032 saved posts remain. No Reddit/CDN requests were made for this feature. Screenshot: /private/tmp/reddit-reader-delete-post-confirmation.png.


## Offline feed simplification — 23 October 2026

Removed post-selection checkboxes, the selection toolbar, summary dialogs/actions and provider status from Settings. The summary generation module, HTTP endpoint and runtime provider configuration are removed. Previous summary evidence above is historical and no longer describes an available feature. Existing legacy cache cleanup remains covered by post/source/Clear tests, without deleting any stored user content during this change.

Archive comment imports retain their bounded behavior through an optional post-ID field in the import dialog, rather than feed selection. The combined offline feed, saved discussions, filters, syncing, history, media and deletion controls remain in place. Verification uses local fixtures; no Reddit/CDN or model calls are required.

Validation: TypeScript and production build pass, with 71 unit/workflow checks and 24 local Chrome/API/network integration checks (95 total). The actual app was restarted and reloaded: zero feed checkboxes or summary buttons, Settings has no provider status, saved images still render, and all 1,032 real posts remain. Session requests stayed at zero. Screenshot: /private/tmp/reddit-reader-offline-feed.png.


## Direct archive fetching — 23 October 2026

The archive dialog now defaults to a subreddit and inclusive UTC date range, with an all-available-history option. Direct Arctic Shift API collection is programmatic, without Reddit credentials or AI. Jobs persist content/cursor/counters/boundary IDs/media phase atomically, save supported media through the existing worker, and support explicit Stop/Resume after restart. All archive/browser/CDN HTTP dispatch shares the completion-based five-second queue. No automatic startup work or failed-request retries. 429 cooldowns accept Retry-After, reset seconds, and reset-at timestamps in seconds or milliseconds. Invalid ordering, source/range mismatches, redirects and unsupported formats pause without advancing progress. Same-second boundaries replay and deduplicate; an unpageable saturated timestamp is reported explicitly without claiming completion.

Removed the former 2 GiB input, 8 GiB decoded and one-million-record total limits from streamed file imports. Per-record and decoder-memory guards and the user’s combined storage cap remain. A streamed 1,000,001-record fixture completes without retaining the whole input. File upload remains a secondary path for bulk exports and bounded comment samples.

Validation: 82 unit/workflow checks and 27 local Chrome/API/network integration checks pass (109 total), alongside TypeScript and the production build. New tests cover tied timestamps, atomic rollback at capacity, exclusion/live precedence, restart during the media phase, late results after Stop/Clear, rate cooldowns, automatic local images, authentication, new subscriptions and mobile layout. The in-app browser live check exposed date inputs whose edits were not retained; using input events fixes the issue and the focused Chrome workflow was repeated successfully.

Live app check: r/python, 1 January 2010, imported four new posts across two archive requests. No Reddit or CDN requests were needed for these link/text posts. Original 1,032 posts remain, for 1,036 total. The app is idle after completion. Live provider-boundary probes independently confirmed strict lower-date handling and millisecond overlap. Screenshot: /private/tmp/reddit-reader-direct-archive.png. This bounded success does not establish complete lifetime archive coverage or test every historical media host.


## Feeds layout redesign — 23 October 2026

Replaced the responsive faux table with labelled feed cards: identity/counts and status/Refresh in the header, aligned Activity and Stored history facts, readable error notices, and a footer grouping history settings and Clear/Remove controls. Cards use two columns when space allows and stack their details on small screens. Obsolete table/breakpoint rules were removed. Timestamp precision and all collection/deletion behavior are retained.

TypeScript and the production build pass. Fifteen local browser/API integration checks pass, with a focused Feeds check repeated after the final responsive grid change. Desktop (1280 px), mobile (390 px), and the real in-app browser were visually inspected without horizontal overflow. Real Clear/Remove confirmations were opened and cancelled; all 1,036 saved posts remain and session requests stayed at two (unchanged from the prior archive test). Screenshot: /private/tmp/reddit-reader-feeds-redesign.png.

## Live archive recheck and Media filter — 27 October 2026

The exact Python query that returned HTTP 500 during the 25 October exercise now
returned HTTP 200, with 66 posts for 1 January 2020. A minimal query using plain
ISO dates and limit=1 also returned HTTP 200. All 66 original records passed the
app's archive parser. The parameters were compared against the provider's
[API documentation](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md),
which explicitly supports full ISO timestamps, ascending sort, limit=100 and
subreddit/date bounds. These results do not establish the cause of the earlier
500s; a transient failure is plausible and a malformed-query defect was not
reproduced. The unnecessary undocumented meta-app parameter was subsequently
removed, without claiming that it caused the previous failures.

A separate bounded live check used the actual server/archive/store pipeline
against r/AskHistorians for 1 January 2020. It fetched three pages, accepted and
stored 161 posts, reported zero parser omissions, reached its terminal page and
completed. All returned posts in this trial were text/link content, so no media
requests were required. The database was closed and reopened to verify saved
posts and the completed archive checkpoint. This validates these returned
records and workflow, not every historical post or historical media provider.

The five total external requests in the two checks all went to Arctic Shift;
no Reddit requests were made. Both checks used the real completion-based
five-second request queue. The main library and sign-in profile were untouched.
Request/results evidence and the isolated SQLite database remain under the
Git-ignored .local-data/qa/2026-10-27/ directory.

The new Media filter combines Image/Video classifications and accepted discovered
attachments without duplicate posts, excludes text-only posts, and composes with
subreddit, search and pagination. Body previews are hidden in this mode; titles,
discussion controls and local file copying remain. The browser fixture checks
both media kinds, absence of text previews and rejection of invalid API filters.

Validation: TypeScript and the production build pass; 122 unit tests pass with
two test workers, and all 37 browser/API/network integration tests pass. An
earlier unit run overlapping the full Chrome suite hit the existing feed-sync
fixture's four-second settle timeout; no timing limit was changed, and the
bounded two-worker rerun passed. The new filter was also manually exercised in
the isolated app: ten media posts across two fixture feeds, five after selecting
aww, no body previews, and cached local image/video decoding. The app's request
counter remained zero during reading and its console reported no errors.

## Resumable gaps and offline-media labels — 27 October 2026

Stopped history checkpoints and pending/failed downloads remain Incomplete,
including when other media in the same feed is unavailable. A new regression
closes and reopens a real SQLite database after Stop, then verifies that explicit
Sync checks the newest listing and collects the missing page from the saved Next
URL before finishing. Known unsupported media cannot mask that unfinished work.

The review found an inconclusive-discovery bug: a native player timeout (or empty
discovery result) was classified as permanently unavailable. These outcomes now
remain retryable failures. Tests exercise the actual rendered discovery adapter
with an accelerated timeout and verify that only later explicit syncs retry an
empty/transient discovery result until a file is saved. Known unsupported
providers, incomplete galleries and explicit post-removal evidence retain their
separate handling.

Feed cards and the thread drawer now show orange Not downloaded / Partially
downloaded pills, with reasons below the content. Unsupported embeds remain
visible with an explicit Open original link; no remote player is loaded while
reading. Local status lookups first show Checking local media, and a failed
lookup shows Status unknown rather than claiming that a saved file is absent.
Feeds exposes awaiting-sync, retryable and unavailable counts separately and
explains Resume for unfinished work.

Validation: 124 unit tests and all 38 local Chrome/API/network integration tests
pass. The first integration run exposed two fixture expectations that needed
updating: the newly visible pending count, and empty test post hosts that had no
rendered size. After fixing the fixtures, the full suite passed. Manual in-app
browser checks confirmed the orange pill, original link, saved-video local path,
thread drawer and Incomplete/Resume explanation using the isolated fixture
library. No external requests were made during this task; the user's library
and browser profile were untouched.

## Online players and future content sources — 27 October 2026

The user's later preference replaces the link-only presentation for supported
external videos: YouTube and Vimeo have inline online players, while the orange
Not downloaded pill and explicit original link remain. Loading/playing an embed
never changes the download ledger, collector request counter or storage usage.
Online player traffic goes directly from the reading browser to the provider;
it is separate from the collector's five-second queue. Saved local media keeps
its existing offline path and other unknown providers retain an original link.

Player URL parsing is a small shared module independent of Reddit extraction.
It accepts known video URL shapes, upgrades legacy HTTP links to HTTPS players,
retains Vimeo's supplied unlisted hash and discards arbitrary embed HTML and
source autoplay/tracking parameters. Video preview images cannot count as a
saved external video. Repository instructions and the plan now explicitly treat
Reddit as the first platform and distinguish platform identity from live/archive
provenance, without introducing a speculative plugin framework.

The server permits only the two player origins in frame-src and retains local
script/connect restrictions. Frames have scripts/same-origin/presentation
permissions, no autoplay and an origin-only cross-site referrer. The global
no-referrer policy remains unchanged. This follows YouTube's documented
[privacy-enhanced embed mode](https://support.google.com/youtube/answer/171780)
and [referrer requirement](https://developers.google.com/youtube/terms/required-minimum-functionality).
Vimeo's [unlisted-video guidance](https://help.vimeo.com/hc/en-us/articles/12426470858001-Embedded-player-displays-This-video-does-not-exist-message)
explains preservation of its existing privacy hash. Provider restrictions can
still prevent a particular video from playing; no bypass is attempted.

Validation: TypeScript and production build, 128 unit tests and all 39 local
Chrome/API/network integration tests pass. Mock provider frames play a real MP4
fixture on a user click, retain the orange warning, send only the local origin
as referrer, preserve download state and fit the mobile layout. Failed provider
requests leave the post, warning and original link visible. A separate manual
in-app browser check loaded and played one official YouTube sample for 26
seconds, muted it and paused it, while the orange pill remained visible and the
collector count stayed zero. The screenshot is in the ignored QA directory.
This live check contacted YouTube/its player resources; Vimeo playback was
checked with fixtures, not a live provider call. No Reddit collection ran, and
the user's library and sign-in profile were untouched.

## Offline-content completion audit — 27 October 2026

The full audit and remaining explicit source boundaries are recorded in
[OFFLINE_AUDIT.md](OFFLINE_AUDIT.md). Native galleries now use the actual Classic
grid/Next controls and verify each visible slide against the reported IDs/order.
The original rendered full-size link is preferred over its preview. Ordered
collection evidence and captions persist before file downloads; Stop/restart,
refresh and on-demand discussion reads preserve that evidence.

Sync now automatically reads full post text, retains link destinations and
original inline-image references, and re-reads observed updates. A durable text
ledger prevents absent or stale bodies from counting as complete, even across
restart. Discussions remain on demand, as the user clarified. A preserving
additive schema upgrade queues previously unverified live text without starting
network traffic. Text and media progress are visible separately.

Complete archive gallery/native-video metadata supplies explicit file evidence
without a Reddit visit. Silent 20-file truncation and the 40-file queue cutoff
are removed; bounded batches continue under the existing request budget. Mixed
missing/temporary failures do not strand later batches or retry themselves within
the same run. Media streams under the user's storage cap instead of fixed file
size limits. Safe observed CDN redirects are followed with pacing; invalid
manifest/discovery work remains retryable. Former implementation-limit failures
are reopened while genuine missing-file gaps stay unavailable.

Five bounded live checks used one existing six-image public gallery. Browser
request releases were 12 (first probe hit its ceiling), 13, 13, 21 and 21; the
last check made six additional CDN requests and saved all six files. Total:
80 browser releases plus six CDN fetches, all through the completion-based
five-second gate. No Reddit API calls, screenshots, hidden state, guessed URLs
or AI extraction were used. These are dispatch counters, not reconstructed server
logs. An intermediate diagnostic using direct page.goto was rejected by automatic
approval review because pacing was not established; it did not execute. Subsequent
checks used normal ReaderBrowser.navigate through the installed gate.

The real files were reopened in an isolated app with all website navigation and
new media downloads disabled. All six images decoded from local URLs: 3264×1484,
4608×2096 (two images) and 1864×4096 (three images). Horizontal gallery browsing,
the six local paths, the saved/total count and a full-text fixture were inspected
in the in-app browser with zero collection requests. Screenshot and dimensional
evidence remain in the ignored 2026-10-27 QA directory. The user's main library
was inspected read-only; collection results were stored only in the isolated QA
database/media directory, using the existing sign-in browser profile.

Final validation: all 141 unit tests and 44 local integration tests pass, plus
type checking, production build and Git whitespace checks. The integration suite
includes offline image/video playback, captions, local paths, source ownership,
capacity, request pacing, interrupted work and database upgrades. The online
player fixture loops its short sample to avoid racing clip completion when
asserting playback; production playback behavior is unchanged. The detailed
resolved-gap inventory and remaining source boundaries are in OFFLINE_AUDIT.md.

## Randomized request spacing — 27 October 2026

At the user's request, the shared collector queue now samples a fresh uniform
4–6 second gap after response readiness instead of the fixed five-second gap.
Browser and archive traffic, media redirects, manifests and separate video/audio
tracks all use the policy. Sampled deadlines survive cancelled waiters and browser
restarts. Longer service cooldowns, navigation waits and request budgets remain
in force. The sidebar, archive dialog and sign-in instructions describe the range.

Validation: 143 unit tests and 44 local integration tests pass, plus type
checking, production build and Git whitespace checks. Injected clocks and random
samples verify exact 4/6-second endpoints, varying intermediate gaps, response
completion, cancellation, shared archive/media pacing and video/audio hops.
Local Chrome fixtures verify request gating and offline playback. No Reddit or
other external collection requests were made for this change.

## Read tracking — 27 October 2026

Read status now persists independently of observations, with All/Unread/Read
filters, stable unread-view snapshots, a Refresh view action and manual overrides.
Viewport sampling requires one second of unobscured visible coverage; tall cards
need every vertical section, and resizing resets coverage. Hidden tabs, dialogs,
pending media layout and fast scrolling do not mark posts read. A manual unread
override persists while the card stays on screen. Sync and import preserve read
status; deleting/clearing content removes it. Version-two libraries receive an
additive read-state upgrade, and version-one libraries traverse both upgrades.

Validation: 145 unit tests, 45 local integration tests, type checking and build
pass. The real Chrome fixture exercises hidden tabs, modal overlays, overrides,
stable unread results, tall-card coverage and reload persistence. It caught and
verified the fix for rounded corners interfering with obstruction hit tests.
No website collection requests were made.

## Encrypted backup and restore — 27 October 2026

Settings now creates password-encrypted age backups and downloads them as files.
Restore decrypts into private staging, authenticates the complete stream, validates
strict TAR names, checksums, schema, post/media references and cache metadata, then
offers an explicit replacement confirmation. Preferences, exclusions and reads
are preserved. Browser profiles are excluded and remain at the destination; the
next explicit collection verifies its account. Backup creation/replacement pauses
collection and blocks concurrent mutations. A rollback database, previous media
directory and startup recovery marker protect interrupted publication. Downloads
and uncommitted validation tickets expire; an active replacement cannot expire.

The established format is supplied by age-encryption 0.3.1, with production scrypt
work factor 18; TAR streaming uses tar-stream 3.2.2. See BACKUPS.md for format,
staging-space and recovery details. Live-library encryption remains deferred.

Validation includes streaming an 8 MiB fixture, production password encryption,
wrong passwords, truncated/tampered/interrupted inputs, unsafe TAR paths/links,
capacity changes, snapshot disk failure, publication rollback and startup recovery.
The Settings workflow downloads a real encrypted file, rejects a wrong password,
validates without publishing, cancels and then confirms replacement. No Reddit
requests or real user-library changes were made. Unit concurrency is bounded to
four workers; the production KDF check runs with integration checks rather than
competing with short unit-fixture deadlines.

Final stage checks: 151 unit tests and 47 local integration tests pass, plus
type checking, production build and Git whitespace checks. A current-cap recheck
protects confirmation after settings changes; a failed rollback snapshot leaves
the validation ticket retryable without modifying current content.

## Scoped indexed search — 27 October 2026

The feed now has Title/Body/Title + body scopes, defaulting to both. Literal
Unicode-normalized substrings compose with source, media, read status and cursor
filters; removed and superseded text cannot match. Responsive controls remain
usable at mobile width. Schema 4 adds a transactionally maintained normalized
text table and SQLite FTS5 trigram index. Index hits narrow rare queries; broad
terms fall back to the complete literal scan without truncating results. One-
and two-character queries remain supported by scanning normalized text. Index
rebuild uses the same reader provenance rules; deletion cascades and Clear remove
indexed content. Backups from published schema 3 validate before being upgraded
inside staging, and restore rebuilds the index from validated content.

An isolated 50,000-post benchmark used a 631 MB long-text library. Before indexing,
absent body/both queries took roughly 3.8–5.2 seconds. With indexing, absent
queries took 0–2 ms and common matching body/both queries took 12–16 ms after
optimizing broad hits. Short absent body queries still took about 1.1–1.2 seconds
on that deliberately large text dataset. The indexed database occupied 1.75 GB;
this overhead is included in the storage cap. Results are local measurements,
not throughput guarantees. The generated database was removed after measurement;
JSON results and the reproducible script remain in the ignored QA directory.

The full 155-test unit suite passes. All 48 integration cases pass after updating
capacity fixtures to leave room for the new index. The checks exposed and fixed
a real reclamation issue: cleared index segments needed rebuilding/optimization
before VACUUM could reclaim their storage. Backup identity validation now also
rejects noncanonical post/feed/exclusion IDs. Type checking, production build and
Git whitespace checks pass. No external collection requests were made.

## Storage management — 27 October 2026

Settings now shows physical media/metadata and database/index allocation, with
per-feed attribution that splits shared bytes without double-counting. Stored
content from unsubscribed feeds remains manageable. Selective deletion defaults
to read posts and supports feed, type and an exclusive UTC cutoff. Preview pauses
collection, captures stable identities and revisions, and shows affected posts,
reclaimable media and shared files retained. Confirmation rejects expired or
changed selections. Batched deletion is atomic, preserves exclusions, removes
read/discussion/search data and releases only media with no remaining owner.
Reclaim compacts database/index space and removes unassigned files without
pruning content. File/compaction failures are reported after logical deletion.

Inventory reconciles missing local files and capacity accounting without network
requests; unfinished work becomes retryable. Active downloads cannot overwrite
newer file accounting during inspection. Backup preflight checks local inventory,
and concurrent reads wait until a restore has published both database and cache.
A browser regression exposed mobile overflow from an unbroken post body; the
feed grid now constrains its column. The full 158 unit and 50 integration tests
pass, along with type checking, production build and whitespace checks. The
unit suite was run separately from the Chrome suite to avoid resource-contention
timeouts in fixtures saving more than 100 files. No external collection was used.

## macOS launcher and final workflow verification — 27 October 2026

The executable Collector.command and npm run launch build the current UI and
open the local app. A matching active checkout/library is reused. Independent
libraries can run together; a busy default port falls back to an available local
port, while an explicit PORT reports its conflict. Both CLI entry points now
claim an OS-backed SQLite coordination lock before opening/recovering the primary
database. A private discovery record supplies instance identity and its local
address; it is not the lock itself. Concurrent processes cannot acquire ownership,
and an actual SIGKILL test verifies automatic OS-lock release and stale-record
replacement. Sharing another checkout's active library is refused. A
macOS file-ownership check detects legacy processes that predate coordination.

Settings provides Quit app. Shutdown stops listening, aborts collection/imports,
waits for in-flight handlers, closes the database and releases ownership. It also
works when restore recovery blocks other library operations. Repeated close is
safe; quit/relaunch preserves content and starts with zero collection requests.
The Finder script handles spaces, nvm/Homebrew paths and runtime errors. Missing
Chrome/FFmpeg produces a collection warning without preventing offline reading;
no dependencies are installed silently.

The final full run passes 160 unit and 54 integration tests, type checking,
production build, shell syntax and whitespace checks. Integration coverage adds
actual UI Quit, authenticated shutdown, starting/build failures, port conflicts,
isolated libraries, checkout mismatch, legacy-file ownership and crash recovery.
Browser suite concurrency is capped at two. Disk-heavy 120-file fixtures have a
30-second test deadline rather than failing under unrelated disk contention;
production session/request limits are unchanged.

Manual testing used an isolated six-post/two-feed library, with local gallery and
video fixtures and no Reddit/CDN requests. The real launcher build, scoped
search, viewport/manual read state, encrypted backup creation, storage inspection,
cleanup preview/cancel, Quit and relaunch were exercised. This found a backup-
creation callback that unnecessarily reset reader filters; only restore now
resets them. The fix passes the six backup/launcher integration cases and was
rechecked manually. Existing live user data and its running app were untouched.
The temporary QA app was stopped. The storage screenshot is in the ignored QA
directory at .local-data/qa/2026-10-27/storage-final.png.

Live-library encryption remains deferred. Backups are encrypted; the working
SQLite database, media and temporary restore/snapshot staging are not encrypted
by Collector. Source availability and the agreed online-provider exceptions
remain as documented in OFFLINE_AUDIT.md.

## Recent-change and general reviews — 27 October 2026

Codex reviewed the changes since the first published revision, then reviewed the
whole codebase after the first set of fixes. Claude CLI independently completed
the same two stages using Opus 5.5 (`claude-opus-5-5`) at xhigh effort. A short
Claude verification pass checked the subsequent import, feed and media fixes.
Claude read sanitized copies of tracked source, tests and documentation with
read-only tools; it had no runtime data, browser profile, credentials or Git
metadata, and did not execute tests or make collection requests. Both full Claude
passes reported no Critical or High findings. Its findings were triaged and
verified against the implementation; the local regressions below provide the
runtime evidence.

Confirmed issues fixed:

- Startup now observes media-cache initialization errors, preserves their cause
  through shutdown and releases ownership. Valid stale discovery records survive
  moved/copied libraries; the OS lock still prevents concurrent owners. Read-only
  inspectors are allowed, probe paths remain tied to the requested library, and
  terminal hangup closes both entry points. Slow-start messages no longer tell
  users to quit a still-starting process.
- Restore validation respects cancellation after upload, and cleans staging
  without publishing a confirmation ticket. Restore preserves the destination
  storage cap and compacts the old database allocation, reporting compaction
  warnings. Backup, restore and storage maintenance pause collection with the
  relevant reason rather than claiming the application stopped.
- Short posts require an uninterrupted full viewport view; tall posts retain
  accumulated coverage. Finished broken images and clipped lazy gallery images
  no longer block reads. Client response ordering, server intent sequences and
  library/source context prevent late reads from undoing newer manual choices
  or crossing a clear/restore. Feed refreshes preserve confirmed read changes
  that completed while a response was in flight.
- Background feed updates retain the loaded time/ID window and visible scroll
  position instead of discarding pages after the first 50 posts. Older history
  added outside that window remains accessible through Load more. The thread
  drawer uses the current saved post body while retaining older sampled comments.
- Replaying a stopped or capacity-limited file import retains stable observation
  provenance, and identical archived discussion samples are reused. Increasing
  capacity can then reach remaining records. Identity is bounded to metadata
  and the first 64 KiB, not a full-file checksum; the README describes that
  limitation. New attempts stopped before identification cannot masquerade as
  legacy imports that actually accepted records. Clear removes the identity
  mappings for the affected content.
- Explicit Resume rediscovers expired ordinary image URLs as well as gallery
  and manifest URLs, preserving that requirement through interruption/restart.
  Reconciliation aborts downloads whose original post no longer owns the asset,
  even if another post still owns it. An explicit Imgur removed-image redirect
  is treated as unavailable rather than saved as the post's image.

Transient access/server failures remain resumable. Repeated 403 or 5xx responses
are not sufficient evidence that content is permanently missing, and cannot
advance an archive past an unfinished media checkpoint. The removed-image
redirect and expired-URL cases were verified with local fixtures; external host
behavior was not rechecked live. No Reddit, archive-service or CDN requests were
made during this review. Tests use temporary libraries; the running user app and
its library were untouched.

Final validation passes: 171 unit tests, 64 browser/integration tests, TypeScript
checking and the production build. The browser suite ran separately with two
workers, including real localhost HTTP pacing, launcher child processes,
encrypted backup/restore, file-import replay, read-response races, retained feed
windows, ownership changes and existing extraction/history/deletion workflows.
No confirmed review finding remains unresolved. Very large library performance
and current third-party website behavior are outside these local test results.

## Post and user favourites — 27 October 2026

Posts and authors have separate star controls in the feed and thread drawer.
Favourite posts and Favourite users are sidebar views with the existing search,
read, media, community filters and paging. The user view combines locally stored
posts across favourite authors and can be narrowed to one username. It includes
retained content from unsubscribed feeds and subsequent sync/import results;
favouriting itself never starts collection or follows an account on Reddit.
The controls use a compact two-column action area on posts and were inspected
at desktop and mobile widths.

Author identities have platform-scoped keys. Reddit adapters validate rendered
profile links and archive author names, normalize case for identity and preserve
display casing. Missing evidence preserves known authors; explicit deleted
author markers suppress older archive attribution. Author-only discussion data
cannot reinstate a removed post. Earlier posts without author evidence remain
unknown until collected again or read through the discussion action. No extra
website requests are made just to backfill author names.

Schema 5 adds author observation evidence, its identity index and favourite
post/user tables. Existing libraries receive an additive upgrade. Post stars
are removed with their collected content; favourite users remain preferences
until explicitly unfavourited. Both are portable in encrypted backups. Published
schema-3 and schema-4 backups are validated before being upgraded only in
staging, with unknown authors and empty favourites. Existing cookies, profiles,
content, read states and deletion preferences are preserved by library upgrades.

Validation covers restart, older-library upgrades, encrypted backup restore,
case/provenance/deletion handling, platform isolation, filter/paging composition,
authenticated mutations and rejection of stale post contexts. Browser checks
exercise post/user stars, removing a favourite without deleting content,
cross-subreddit author posts, individual author filters, search, future imports,
reload, drawer controls and retained unsubscribed content. Temporary local
libraries and fixtures were used; there were no Reddit/archive/CDN requests and
the running user app and its data were untouched.

Final checks pass: 178 unit tests, 67 browser/integration tests, TypeScript,
production build and whitespace validation. The final integration run includes
the author-only removal regression fix and the compact action layout.

## Final manual workflow pass and independent review — 27 October 2026

A separate manual end-to-end pass used the actual in-app browser UI with an
isolated on-disk library and injected fixture collection adapters. This was
separate from the automated Playwright test suite. The running user app and
library were untouched. No Reddit, archive-service or CDN collection requests
were made. The fixture adapters used local responses and shortened test timing;
production pacing and request limits were unchanged.

Manually exercised:

- Adding two feeds with the one-month default, individual Stop/Resume, Sync all,
  independent feed status, history expansion and contraction without pruning,
  history/provenance timestamps, and unsubscribe confirmation/cancellation.
- Combined, subreddit and media views; title/body search scopes; automatic read
  marking, manual unread, read-status filters, post and author favourites,
  author/subreddit narrowing, unfavouriting without deletion, and retained posts
  from an unsubscribed feed.
- Inline two-file galleries and captions, Copy local path confirmation, actual
  playback of a locally served video (ready state 4, no error, 0.6-second fixture),
  and on-demand saved discussion comments. Restart preserved content, media,
  favourites and read states and started with zero collection requests.
- Archive date fetching, Stop/Resume and overlapping ranges (one existing post,
  zero new posts on replay); a compressed file chosen through the browser file
  picker, replay of that export without increasing the post count, and a selected
  post's imported discussion sample.
- Storage cap changes and sidebar percentages without data loss, storage
  attribution, selective cleanup preview/cancel/confirm, keeping shared files,
  compaction, individual deletion/cancellation and absence after reconciliation,
  scoped Clear and global Clear with confirmation/cancellation.
- Real password-encrypted backup creation and browser download, wrong-password
  rejection, validate/keep-current, validate/replace, and recovery of all 21
  fixture posts, four media files, two post favourites, one favourite user and
  saved read state. Restore retained the destination's 10 GB cap rather than the
  backup's 1 MB cap. Quit was exercised through the UI; the fixture process was
  relaunched and its browser tab reloaded to verify persisted state.

Browser file-picker/download tool calls were unusually slow; this pass does not
establish real-world import throughput. Real Reddit authentication/live markup,
current archive-service availability and external-provider online playback were
not revalidated. Existing local integration fixtures cover extraction, DASH and
audio muxing, pagination, request pacing and failure/recovery cases. Very large
library performance remains unmeasured.

Codex then reviewed the current implementation, and Claude CLI independently
reviewed a sanitized snapshot using Opus 5.5 at xhigh effort. Claude had only
read-only source/test/documentation tools, with no runtime data, credentials,
browser profile or Git metadata. Its generic pass prioritized the current
favourites, store/server, media and job paths; this was not an exhaustive read of
every unchanged file. Codex also reviewed archive/import, history, backup and
request-lifecycle interactions. No high-severity finding was reported.

Five confirmed findings were fixed and regression-tested:

- Cached media from an unsubscribed feed returned 404 despite remaining owned
  and reported as ready. Cached serving now checks post availability and file
  ownership independently of subscription. Downloading still requires a
  subscription. New coverage opens images, a complete gallery and video from a
  removed feed without a warm browser cache, and checks that deletion/Clear
  still revoke access.
- Reading a retained discussion could queue unrelated media discovery that
  would fail for an unsubscribed feed. Such discussion reads no longer queue
  media work; their existing pending media stays pending.
- Returning home or Back from a stored-only subreddit filter could leave an
  empty normal feed. Normal navigation now drops invalid subscription filters;
  favourites retain their ability to filter stored-only feeds.
- Load more could cancel an in-flight head refresh after polling had already
  consumed the content revision. The pending revision now remains outstanding
  until a full refresh displays it, so polling retries even without another
  content change.
- An author filter removed in another window could silently reactivate if that
  author was favourited again. A missing selected author now clears the stored
  filter, preserving the displayed All favourite users selection.

Claude's short verification pass found no remaining confirmed defect in these
five fixes. Final validation passes 179 unit tests, 71 browser/integration tests,
TypeScript checking, the production build and whitespace checks. The retained
gallery fix was also checked manually after restarting the fixture app: both
local images decoded after unsubscribe, and home navigation reset the stored-only
filter. No browser warnings or errors were recorded in that final check.

The isolated app was stopped. Manual screenshots and recovery/fixture files are
in the ignored `.local-data/qa/2026-10-27/final-pass/` directory; screenshots
include `manual-restored.png` and `manual-retained-media.png`.

### Compact media controls and full-screen viewing — 27 October 2026

The earlier manual sample labelled “Offline video with audio” mistakenly used
the audio-only input fixture. Its readiness/playback checks did not establish
that a picture was present. The ignored sample script and its cached file now
use an eight-second MP4 with a 320×180 video track and an audio track; the original
sample is preserved outside the cache. The retained-media test now also asserts
video dimensions. The new player test verifies picture dimensions and decoded
audio, plus playback, seeking, mute/volume and uninterrupted native full screen.

Saved media now uses a 30px playback row and image/video full-screen viewing.
Local Chrome checks cover native full screen and denied-API fallback, gallery
captions, focus restoration, mobile layout, read tracking and Esc within a
discussion. A manual check in the app browser verified the compact player,
video enlargement, the second gallery image, its caption and Esc. That browser
used the viewport-sized fallback. No Reddit or media-provider requests were
made. TypeScript checking, the production build and all 77 browser/integration
tests pass. `manual-compact-video.png` is saved with the other ignored screenshots.

## 28 October 2026 — public Tumblr follow-up

One live `https://staff.tumblr.com/` probe through Collector's own Chrome profile
and the shared random 4–6 second queue was denied with HTTP403. Counters showed
one released request; collection stopped immediately, with no retries, alternate
endpoints or authentication bypass. Live compatibility is still unverified.
Local browser fixtures verify complete ordered NPF/inline media, captured
post-bound legacy photosets/native video frames, mixed-source request accounting,
pagination, offline serving and pause/resume. Tumblr sign-in remains deferred.


## 29 October 2026 — default public Tumblr website works

The custom-theme `staff.tumblr.com` hostname returned HTTP403 with the rendered
message “Javascript required” and a browser-check title. A bounded comparison
with ordinary JavaScript loading also returned 403 and stopped. No challenge
solving, fingerprint changes or login was used. Tumblr's own theme documentation
identifies `tumblr.com/blogname` as the default blog view:
https://help.tumblr.com/knowledge-base/customizing-your-theme/ .

The captured default public Staff listing and individual permalinks returned
HTTP200 with JavaScript disabled. Visible articles, bookmark links, blog-bound
Like-control identifiers, srcset media and explicit publication metadata suffice
for extraction. Blog-level parsely metadata is the blog creation date and cannot
supply post dates. On reblogs, canonical/Open Graph metadata names the original
post and its publication date; acceptance requires a confirming visible bookmark,
while the requested blog's controls still bind the saved reblog ID. Original
publication dates are labelled and excluded from chronological history evidence.
No hydration-state traversal or API requests were used. Scripts, automatic media,
fonts, fetch/XHR and unrelated frames remain suppressed; CSS and explicit page
navigation use the existing 4–6 second paced request gate.

An isolated live sync stored the 17 exposed posts. We deliberately paused after
11 media files to avoid downloading hundreds of gallery attachments merely for
QA. All four files in each of two galleries decoded from local `/media/` URLs
while Offline mode was on, including `.pnj` PNG and `.gifv` animated images.
Fullscreen next-image navigation and Escape worked in the in-app browser. Saved
progress survived a server restart, which began offline; re-enabling collection
and explicitly resuming continued the listing. The earlier reblog validation
failure was recorded in the local problem log and fixed. The Staff public view
exposed no next-page link, so this is finite public coverage, not full-history
verification. Sign-in remains deferred. Across the bounded diagnostics and live
checks, 48 requests were released; no HTTP429 occurred. No normal-library feeds
or content were changed.

Checks: TypeScript and production build, all 208 unit tests, all 119 browser/
integration tests, and a subsequent focused run of the 11 Tumblr browser tests
covering reblogs/self-reblogs, identity rejection, date provenance, ordered media,
partial-page pause/resume and retained checkpoints. Screenshot and diagnostics
are in the ignored `.local-data/qa/2026-10-29/tumblr/` directory.


## 29 October 2026 — older Tumblr discovery and sign-in prerequisite

Primary guidance:
- Archive/month filters and dated theme pages:
  https://help.tumblr.com/knowledge-base/lesser-known-features/
- Documented `from`, `year`, `since` and `before` search operators and pre-2017
  indexing restrictions:
  https://help.tumblr.com/knowledge-base/search-and-filtering-basics/
- Logged-out browsing can deliberately require sign-in partway through:
  https://help.tumblr.com/knowledge-base/appearing-in-search-results/
- Tag search does not include reblogs (same visibility guidance above).
- Third-party backup options are not browser-only substitutes: tumblr-utils
  requires a personal Tumblr API key, while TumblThree documents SVC/API routes:
  https://github.com/bbolli/tumblr-utils/blob/master/tumblr_backup.md
  https://github.com/TumblThreeApp/TumblThree
- Internet Archive documents resumable URL-index queries:
  https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server

Bounded live results, all through the existing random 4–6 second queue:
- Public Staff listing: 17 articles, no captured archive/next link.
- Documented `staff.tumblr.com/archive`: HTTP403 JavaScript challenge; stopped.
- `from:staff year:2025`: HTTP200, 15 rendered articles. The captured `/recent`
  link returned 15 articles too, with no older-page anchor. Ranking must not be
  treated as chronological cursor evidence.
- `from:staff since:2025-01-01 before:2025-02-01/recent`: HTTP200, three posts
  dated January 7, 14 and 28. This demonstrates genuine discovery beyond the
  initial listing without a Tumblr API call.
- One captured January permalink: the production extractor returned a full
  2,990-character post and 20 ordered attachment references with three released
  requests. No gallery downloads were triggered in this investigation.
- Year 2010 and October 2026 intervals: HTTP200 but no articles, explicit empty
  text or JSON-LD result count. The public DOM included the matching query input,
  timeline identifier, suggestions and a loading skeleton. This is insufficient
  evidence to classify an interval as completely empty or permanently advance a
  history checkpoint.
- One documented Wayback CDX prefix query, limited to three URL records: response
  timed out; one request was released and the browser closed. Archive discovery
  remains unverified. No repeated requests or alternate archive hosts were tried.

The user explicitly approved adding manual Tumblr sign-in if needed. Implemented
separate Settings controls and a Tumblr interactive browser using its isolated
local profile, the same request gate and 150-request sign-in budget as Reddit.
Normal interactive resources support the site's login flow; collection still
reopens under the existing stricter script-disabled Tumblr policy. Offline mode
closes the window and resumes the same platform when allowed again. A denied
Tumblr manual login ends manual state and preserves its source service pause.
No passwords, cookies, tokens or authenticated page data were extracted.

The real login page exposed Email/Password fields and the Log in button under
the production profile/routing code. The first bounded readiness check stopped
before the body appeared; a longer check verified the form, releasing five
requests before closing. No form was submitted. Successful authentication and
signed-in archive/history remain blocked on the user completing login. Local
UI checks exercised the controls with a fake driver to avoid extra external
requests; browser fixtures cover both sources, invalid source rejection,
source cooldowns, source-preserving Offline resume and stale Finish rejection.
Normal-library collection was never enabled.
