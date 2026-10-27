# Reddit Reader

A local web app for reading selected subreddits on demand. Uses its own signed-in Chrome profile, Playwright, structured rendered Classic Reddit HTML, React, and SQLite. No Reddit API, hidden hydration state, screenshot-based collection or AI navigation. Post text comes from rendered DOM; syncing downloads supported media files for offline reading.

Viewport-based read tracking, encrypted backup/restore, scoped indexed search, storage management and complete native galleries are implemented. The [next-stage plan](PLAN.md#current-scope-and-next-stage--27-october-2026) records the remaining launcher. Live-library encryption is deferred until after them.

Read status is local to Collector. A card is marked read after its full visible
area has been shown for one second while the page is visible and unobscured.
Tall cards accumulate viewed coverage; fast scrolling and incomplete media layout
do not count. Use the circle beside a post to override its status. Mark unread
stays unread while it remains on screen. All / Unread / Read filters compose with
the existing filters; newly read cards stay in an Unread view until **Refresh
view** or a filter change. Sync, import and restart retain read status. Deletion
and Clear remove it with the content.

## Run

Use Node **25.3.0** (`nvm use`). Its built-in SQLite and Zstandard APIs are experimental. Installed Google Chrome is the default browser; Chrome's security sandbox is enabled. Dependencies are locked.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3210**. The compact dark All subreddits feed filters by subreddit, media type and text. **Media** combines image and video posts, hides text previews, and retains the post title, discussion and local-path controls. Text-only posts are excluded; **Image** and **Video** remain available separately. It is the single combined-feed destination in the sidebar. Post selection and AI summarisation have been removed. Open **Feeds** to view subscriptions, stored counts, per-subreddit sync status and the last successful offline sync time. Add a feed there with a history limit: **1 month** (default), 3 months, 6 months, 1 year, 2 years, 3 years, 5 years, or All time. The same setting is editable beside each subscription. Add & sync starts an explicit session. Sync a feed individually or use Sync all; already active/queued feeds are skipped. Nothing scrapes on application startup.

**Sync** combines new-post catch-up, unfinished history and supported media downloads. A feed shows **Saved offline** and advances **Last successful sync** only after all page scans in that run finish and every supported media item is validated and stored locally. **Incomplete** means a page or file still needs work; **Resume** checks newer posts and continues the saved checkpoints without downloading cached files again. Unavailable media, omitted extractions and the end of Reddit's listing are reported as **Completed with gaps**, with a separate Last completed timestamp. Neither partial progress nor completion with gaps advances the successful timestamp. This describes the requested sync, not a guarantee of every historical post or comment; discussions are still fetched explicitly when requested.

Posts and page checkpoints commit incrementally, and completed files are retained on Stop or failure. Stop cancels one feed while other queued feeds can continue; Stop all pauses everything. Removing a feed requires confirmation, stops its work and hides it from subscribed post results, while preserving stored content and history. Expanding a history limit automatically starts the same sync pipeline. Reducing it stops wider work and preserves all collected posts; it never prunes.

On **Feeds**, each subreddit has **Clear data** with a confirmation dialog. Confirming stops that feed’s sync/import and deletes its stored posts, discussions, exclusive media files, import records and refresh/history checkpoints. The subscription and selected history limit stay in place, and locally deleted posts remain excluded. Other feeds and shared media files are preserved. The next explicit Sync starts collecting from the newest listing again; Clear itself makes no Reddit requests. This is separate from Remove feed, which preserves collected data.

Use the trash button on a post, or **Delete post** in its discussion, to delete it locally after confirmation. Its saved discussion is removed; media is deleted unless another stored post uses the file. A minimal exclusion record (post ID, subreddit and deletion time) prevents refresh, history fetching, reconciliation and archive imports from restoring it. Exclusions survive restart and both Clear actions. This does not report or delete anything on Reddit.

Use Settings → Open sign-in browser if the saved session expires. Sign in in the dedicated Chrome window, including any manual challenge, then Finish sign-in. Sync or Resume revalidates the visible account identity. The app supports one account per data directory and refuses to merge a different account. Settings → Clear collected content resets that binding while retaining the browser session and feed subscriptions, so the next sync can verify a different signed-in account. Clearing just one feed does not reset it. Credentials are not stored in application settings or source; the browser owns its normal saved session.

App data defaults to `.local-data/` inside this checkout, anchored to the source location even when launched from another working directory. This Git-ignored folder holds the database, saved media and browser sign-in profile, so separate clones are isolated by default. Set `REDDIT_READER_DATA_DIR` to override the folder or reuse another clone's data:

```sh
REDDIT_READER_DATA_DIR="/absolute/path/to/other-clone/.local-data" npm start
```

Run only one instance at a time when sharing a data folder. Independently running clones need separate data folders and ports; `PORT` changes the default 3210. Existing data in the previous per-user folder is left in place, with no automatic copying. To keep using the previous macOS location, run `REDDIT_READER_DATA_DIR="$HOME/Library/Application Support/Reddit Reader" npm start`.

The server binds only to `127.0.0.1`, validates Host/Origin and requires a per-launch token for mutations. It is a personal local app, not a hosted multiuser service.

Search defaults to **Title + body**, with **Title** and **Body** scopes. It
matches literal substrings with Unicode normalization and lowercase handling;
quotes and punctuation are ordinary text. The local SQLite trigram index speeds
terms of at least three characters. Broad terms avoid building huge result lists;
shorter terms scan saved normalized text and can take longer in large libraries.
The index follows the same live/archive text and removal policy as the reader,
is updated transactionally, and counts toward database storage.

## Backup and restore

Settings provides **Create encrypted backup**, **Download backup** and
**Validate backup**. Use a passphrase of at least 12 characters and keep it safe.
Validation leaves the current library intact; choose **Replace library** only
after reviewing the saved counts, or **Keep current library** to cancel. Backups
include owned media, preferences, exclusions and read states, while excluding the
browser profile. Restore keeps that profile and verifies its account on the next
explicit Sync. Collection stays paused. See [backup format, temporary-space and
recovery details](BACKUPS.md). The working library remains unencrypted.

## Storage management

Use **Settings → Manage storage** for physical database/index allocation and
image/video cache sizes. Per-feed media totals split shared files between their
owners; the database is global. Retained data from removed feeds is included.
**Reclaim freed space** removes unowned cache files and compacts the database
without deleting posts. Inspection only reads local files.

Selective cleanup defaults to read posts. Choose a feed, post type and optional
exclusive UTC cutoff, then **Preview cleanup**. Preview pauses collection and
shows affected posts, media files and estimated media savings. **Delete posts**
requires confirmation of that preview; changed content, ownership or selection
requires a fresh preview. Deletion removes saved discussions/read states, keeps
files still owned elsewhere, and records exclusions so sync/import cannot bring
the posts back. There is no automatic eviction or history pruning.

## Persistence

New databases use schema version 4. Published versions receive preserving additive upgrades, including read states and the search index. Existing version-1 libraries receive one additive, transactional upgrade for durable post-text work, preserving content, media, preferences and deletion exclusions. Previously unverified live text is queued for the next explicit sync; startup makes no website requests. Unknown/prototype schemas and application identities are rejected before writes. To start fresh, stop the app, back up and move aside `reader.sqlite` together with any `reader.sqlite-wal` / `reader.sqlite-shm` files and the `media` directory, then restart. Keep `browser-profile` to retain the browser session.

Feed subscription, history limit, current history goal and newest-check boundary share one `feeds` row. `feed_sync` records completion separately from individual scan checkpoints. Date bounds define scan scope; there are no obsolete recent/since/all-time target types or first-page refresh timestamps. Post-to-media links determine file ownership across posts and communities, so deletion and Clear preserve shared files without a second ownership index. Post and comment removal evidence, exclusions and live/archive precedence remain enforced.

Reopening a current database pauses interrupted scans, downloads and archive jobs. This is normal recovery, not a migration, and makes no website requests. The app verifies saved files on startup and only resumes collection after an explicit Sync/Resume. A content revision drives feed updates independently of sync timestamps. The only feed action endpoint is `/api/sync`; the former refresh/continue/cancel and summary endpoints are absent.

## Website pacing and history

- One app browser and one automated collection operation at a time. A fresh **random 4–6 second delay after response readiness** before the next HTTP request is dispatched, including redirects, CSS and manual sign-in resources. Browser, archive and media requests share this queue; manifest, video and audio hops also receive independent random gaps. Longer service cooldowns and at least ten seconds after page readiness before the next navigation still apply.
- Collector scripts, images, media, fonts, XHR/fetch, pings and miscellaneous assets are suppressed before network dispatch. CSS remains available to determine rendered visibility. Interactive sign-in permits normal resources through the same request gate. Direct image/video links are saved from rendered DOM evidence. Sync fetches full post bodies and downloads supported media for each collected batch, including unfinished content from previously stored posts, before continuing deeper into history. Observed text posts are re-read to capture updates; a listing preview is not treated as the full saved body. Discussions remain an explicit on-demand action. Native galleries traverse every rendered slide, preserve captions and commit the ordered full-size file list before downloading. Complete archive gallery/video metadata can supply those file URLs directly without a Reddit visit. Saved images and videos in the feed and thread drawer use local files. Supported external video players stream online when shown; they are separate from collection downloads and do not count toward offline storage, the collector request counter or its pacing limit. A persistent per-post ledger records pending, downloading, ready, failed and unavailable media. Feeds shows the number of media posts saved offline. Stop preserves unfinished media; Resume finishes it. Native Reddit players without a saved direct file are expanded automatically during sync in the dedicated browser. This media-only mode enables normal page JavaScript and observes the player’s public CDN DASH-manifest/MP4 request URLs, suppressing those requests before dispatch; it never reads hidden state or network text bodies. The bounded DASH manifest is parsed with fast-xml-parser to select an explicit main video file (up to 720p) and any audio track. Those files are downloaded through the paced queue and combined locally using FFmpeg. Low-resolution preview streams are not used as a substitute for the main video. YouTube and Vimeo links also have online players; other unsupported providers retain an original link.
- 429, document 403, lost login, challenge/layout failure or request-control failure stops collection. No automatic retry. This applies to media CDN 403/429 too. Retry-After is a minimum cooldown; explicit Resume is required.
- Every explicit feed Sync/Resume, including adding a feed or expanding history: up to 60 minutes. Each sync session has a shared **120-request ceiling** covering actual browser and CDN requests together. Each page is a scheduling slice so queued explicit thread/head requests can be serviced. Pause closes the collector and preserves the last committed Next checkpoint. Cancel preserves collected content. Restart requires explicit Sync/Resume.
- A date crossing needs five distinct older ordinary records across two batches, with unknown-time cards resetting the evidence. Known IDs never establish completion. Repeat/cycle detection pauses after three no-progress batches. Actual content and checkpoint commit together.
- Extraction reads only the main listing's posts and its Next control; sidebar and recently viewed lists are ignored. A native-video poster never substitutes for its video file. Startup verifies already-saved media against local file metadata; missing files become pending for the next explicit sync. Removed and superseded attachments release their file ownership; unowned files are reclaimed during collection and on startup, while shared files remain available. Reading a discussion preserves known media when the page supplies only text; removal markers still hide the media.
- Website exhaustion means the end Reddit served, not complete historical coverage. The oldest collected date and omissions are visible in Collection history. Imported and live posts share the dated feed but retain provenance.
- Threads save up to 100 initially rendered comments with parent relationships and the actual server-selected sort (observed `best`), not hidden dropdown links. No collapsed/more-comment expansion. Read time, source, sort and known omissions are displayed. A missing post body does not imply the discussion was read. Moderator-removed posts that lack an ID attribute require a matching thread URL, a unique visible post and an explicit removal marker; their comments remain readable while removed text and media stay hidden.

## Per-feed history

Presets use calendar months in UTC, with month-end clamping (including leap years). **All time means as far back as the browser listing serves**, not a guarantee of every post since creation. Older/deleted/private posts may not be discoverable there, and archive inputs can have gaps too.

Missing historical posts and unavailable media are separate gaps. A source may not expose every old post, archives may not contain it, and unreadable/malformed records are disclosed as omissions. Stopped or interrupted work stays Incomplete until explicitly resumed; a stored oldest/newest timestamp does not establish continuous coverage between those dates. A saved post can also have an unavailable image or video while its text remains readable.

**Incomplete** means work remains: Resume checks newer posts, continues the saved history checkpoint and retries pending or failed downloads. This remains true when other posts in the same feed have unavailable media, including after restarting the app. A slow native-video player or an inconclusive discovery result is retryable, rather than being labelled permanently unavailable. **Completed with gaps** means the scan finished with disclosed coverage limits or content that cannot be saved; it does not replace an unfinished checkpoint.

The Feeds page shows the selected limit, total stored posts, oldest and newest observed post dates, live/archive counts, progress and known omissions. These are observations, not proof of contiguous coverage or a percentage of an unknown total. A sparse old archive post never advances the browser checkpoint or closes a live scan.

Expansion creates a new saved goal and resumes the deepest committed browser Next link. It reuses the older checkpoint rather than replaying already scanned history. A separate fresh scan checks any newer gap first; that dependency survives pause/restart. A disconnected rolling window starts a new head scan while keeping older content. No date cursors are invented. Each page and its checkpoint commit atomically. **Selected range scanned** means a conservative inferred date crossing; **Listing end reached** means Reddit stopped serving a Next link. Pauses, budgets, access loss and transport failures remain unfinished. An observed last page can be revalidated after a later expansion. Date-boundary page overscan is retained.

Contraction sends no collection request and deletes no posts, snapshots or archive observations. An in-progress broader job is stopped; its original checkpoint/history record remains available. The selected limit and current goal survive restart, which never starts browsing automatically. The same Sync/Resume control checks newest posts, services the current history goal and saves missing media within its session budget; there are no separate history-resume controls. Clear retains the preference while removing progress/content.

## Older archives

Click **Import an archive → Fetch from archive**. Enter a subreddit and From/To dates, then **Fetch archive**. Dates include the full UTC end day. Leave From blank, or choose **Use all available history**, to start at the earliest available records. A new subreddit is subscribed automatically without starting a live Reddit scan.

The server queries Arctic Shift’s public archive API, not Reddit’s API. No Reddit credentials or cookies are sent to the archive service. One job runs at a time. Archive, browser and media HTTP requests share the completion-based queue with fresh random 4–6 second gaps. Posts are validated and committed in short SQLite transactions with their next cursor; available supported media is saved before the next archive page. Temporary failures and pending downloads retain the media checkpoint and pause the archive; they cannot be counted as a completed page. Permanently missing files (HTTP 404/410), unsafe redirects and unsupported formats are recorded as unavailable gaps, allowing later pages to continue without retrying those same files on every sync. Each explicit Fetch/Resume has one shared 120-request browser/CDN allowance across all its pages; reaching it pauses with the unfinished media checkpoint retained. Resume grants a fresh allowance and finishes that media before continuing to older pages. Arctic Shift API queries use the paced queue but do not consume that browser/CDN allowance. Closing the dialog does not stop the job. **Stop archive** saves progress; **Resume archive** continues it, including after restarting the app. Startup never starts collection. Progress shows the date range, posts checked/new/omitted/excluded, oldest saved timestamp and offline-media counts. Clear data removes matching archive jobs; Remove feed stops its archive while retaining progress and content. Individual post exclusions apply to archive fetching too.

There is no total post-count or download-size ceiling for an archive job. It pauses at your configured storage cap, service throttling, connection failure or invalid responses. Raise the cap or resolve the error and explicitly Resume. A 429 persists a cooldown from Retry-After and the service reset headers; the app never automatically retries it. Fetch pages are individually bounded to 32 MiB and at most 1,000 records. Boundary timestamps are replayed and deduplicated rather than skipped. A saturated single timestamp that cannot be safely paginated pauses with an explanation and keeps partial data; use a bulk archive for that exceptional range. Finishing means the requested archive range was processed, not that every historical post or media file exists. Original live observations and deletion markers retain precedence.

**Import a file** remains available for bulk exports and archive comments. Use an [Arctic Shift export](https://arctic-shift.photon-reddit.com/download-tool) or [bulk dump](https://github.com/ArthurHeitmann/arctic_shift/blob/master/download_links.md). Supports UTF-8 JSONL/NDJSON (one object per line), uncompressed or `.zst`; JSON arrays and `.zst_blocks` are unsupported. The previous 2 GiB upload, 8 GiB decoded and one-million-record session caps have been removed. Files stream with backpressure and short batches until completion, Stop, or the storage cap. The one-million-character record guard and 128 MiB Zstandard decoder-memory guard remain. Interrupted file imports restart from the beginning and deduplicate; direct archive fetches have durable cursors.

Follow the subreddit and import posts first. To import comments from a file, enter up to ten post IDs in the optional Comment post IDs field. The importer retains up to 300 earliest comments per selected post within a shared four-million-character sample budget, then saves the earliest 100 plus retained ancestors. Omissions, missing ancestry and unknown capture time are explicit. Live snapshots take precedence. File import itself makes no network requests; imported files acquire missing media on the next explicit feed sync. Direct archive fetching saves media automatically.

## Checks

```sh
npm run check
npm test
REDDIT_READER_BROWSER_CHANNEL=chrome npm run test:browser
```

Browser integration checks use only local fixtures: sandbox launch flags, paced redirects/resources/frames/workers, suppression/request ceilings, structured extraction, feed filters, thread drawer, history controls, streaming upload, mobile overflow and local API request protection. Delayed-response tests guard filters against stale polling. Failure checks cover repeated history pages, expired media URLs, orphan cache files, compaction failure and bounded import shutdown. No Reddit calls are made by the test suite. Live checks are explicitly bounded and recorded in [FEASIBILITY.md](FEASIBILITY.md).

The earlier diagnostic probe remains available: `npm run probe -- --channel chrome --login --subreddit python`. Close the app's collection/sign-in browser before running it; both use the app-owned profile.

Settings → Max stored size sets a persistent cap for collected data, default **10 GB** (decimal units). The sidebar shows the percentage used and used/cap sizes. It counts the allocated SQLite database, saved media and cache metadata; browser profile, SQLite journal files and temporary download/mux files are excluded. Sync and archive imports/fetches pause at capacity, and oversized content transactions roll back without advancing their checkpoints. Downloads check both declared and streamed sizes and never publish a file that exceeds the cap. Lowering the cap preserves all existing content, even when usage then exceeds 100%; raising it enables explicit Sync/Resume without automatically starting requests. No automatic eviction is performed. Clear also attempts database compaction to reclaim space; a compaction failure reports a warning after logical content and media cleanup. Owned cache files with missing or invalid metadata still count toward the cap after restart and are never served as validated media. Unowned cache files are removed on startup without making network requests. Media streams to disk under the configured combined storage cap; the former fixed 32/128/160 MiB file limits are removed. Large attachment sets drain in bounded queue batches without silently stopping at 20 or 40 files. Parser/validation safety bounds report incomplete work rather than silently truncating content. Disk exhaustion pauses sync. Redirects are followed only to validated HTTPS public file CDN URLs, with pacing and request counting for every hop; unsafe destinations and unsupported MIME types are rejected; all files come from validated public Reddit/Imgur CDN links tied to stored posts. A native-video manifest is limited to 512 KiB, rejects DTDs/custom entity declarations and off-owner URLs, and uses only explicit MP4 BaseURL entries; no media filenames or segment endpoints are guessed. Stop cancels pending/in-flight media for that feed; Clear removes cached files and rejects late downloads. Reddit video with separate audio requires `ffmpeg` on PATH; direct images and single-file video work without it. Startup reconciles saved file metadata without network requests. Previously collected posts and imported archive posts acquire missing media on the next explicit Sync/Resume; archive import itself remains network-free. Failed files are retried only by the next explicit sync. A denied native-video manifest persists the need to rediscover its URLs on explicit Resume, including after restart. Media discovery stores file evidence separately and preserves archive text and provenance. Galleries are complete only when the reported total and every ordered slide have been verified and all files are saved. Interrupted discovery remains retryable; Stop/Resume retains the complete file list and already saved files. Refresh and discussion reads preserve that evidence. Earlier gallery/per-file implementation-limit failures are requeued without reopening genuine HTTP 404/410 gaps. Known external video providers have online players; other unsupported embeds remain links. Offline viewing requires the local app to be running.


Posts with media that is not saved locally show an orange **Not downloaded** pill, or **Partially downloaded** when some files are saved. The reason below the post distinguishes awaiting sync, retryable failures and unsupported/unavailable media. YouTube and Vimeo videos have a playable online embed plus an **Open original** link. The online player is labelled **Requires internet · Not saved locally**, keeps the orange pill during playback, and does not count as an offline download. Other unsupported providers retain their original link. Offline, blocked, removed or embedding-disabled videos can still be opened through that link when available. A local status lookup failure shows **Status unknown**, rather than claiming that a saved file is missing. Feeds shows separate text and media progress, with awaiting-sync, retryable and unavailable counts. Posts identify missing or pending text updates; multi-file posts show the number of saved files and retain captions.

The sidebar shows storage as a percentage of the configured cap plus used/maximum sizes, request spacing (random 4–6 seconds after response readiness), and the session request count. Use **Copy local path** beside the Image/Video pill to copy its exact absolute cache path. If a post has multiple saved files, the button copies their paths on separate lines. Files normally live in this checkout's `.local-data/media/` (or the configured data directory). Cached filenames are hashes without extensions; matching `.json` files contain cache metadata. In Finder, use **Cmd+Shift+G** and paste the media folder path to browse them.
