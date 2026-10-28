import { randomUUID } from 'node:crypto';
import { archivePost } from './archive.ts';
import { archiveRange } from './archive-fetch-state.ts';
import type { ArchiveFetchState } from './archive-fetch-state.ts';
import { subredditName, postId } from './domain.ts';
import type { PostObservation } from './domain.ts';
import type { ReaderStore } from './store.ts';
import type { RequestQueue } from './request-gate.ts';
import type {ProblemReporter} from './problems.ts';
import { retryAfter } from './limiter.ts';

const ENDPOINT = 'https://arctic-shift.photon-reddit.com/api/posts/search';
const PAGE_LIMIT = 100;
const MAX_RESPONSE = 32 * 1024 ** 2;
export interface ArchiveFetchDependencies {
  queue: RequestQueue;
  problems?:ProblemReporter;
  fetch?: typeof fetch;
  assertCanStart?: (resume: boolean) => void;
  onRunStart?: () => void;
  saveMedia: (ids: string[], signal: AbortSignal) => Promise<void>;
}

/** One explicit, durable archive job. Never starts or resumes on application startup. */
export class ArchiveFetcher {
  private controller: AbortController | null = null;
  private completion: Promise<void> | null = null;
  private activeId: string | null = null;
  private store:ReaderStore;
  private deps:ArchiveFetchDependencies;
  requests = 0;
  constructor(store:ReaderStore,deps:ArchiveFetchDependencies) {this.store=store;this.deps=deps;}
  get running() { return this.activeId !== null; }
  get active(): ArchiveFetchState | null { return this.activeId ? this.store.archiveFetch(this.activeId) : null; }
  list() { return this.store.archiveFetches().map(job => ({ ...job, offline: this.store.archiveMediaCounts(job.id) })); }
  private allowed(resume: boolean) {
    if (this.running) throw new Error('Stop the current archive fetch before starting another');
    const cooldown = this.store.getSetting<number>('archiveCooldown');
    if (cooldown && cooldown > Date.now()) throw new Error(`Archive service cooldown lasts until ${new Date(cooldown).toLocaleString()}`);
    this.store.assertStorageAvailable();
    this.deps.assertCanStart?.(resume);
  }
  start(input: { subreddit: unknown; from?: unknown; to: unknown }) {
    const name = subredditName(String(input.subreddit ?? ''));
    const range = archiveRange(input.from, input.to);
    this.allowed(false);
    const now = Date.now();
    this.store.addSubreddit(name); this.store.refollow(name);
    const job: ArchiveFetchState = { id: randomUUID(), subreddit: name, ...range, cursorMs: range.afterMs,
      boundaryIds: [], widePage: false, state: 'running', phase: 'fetching', dataComplete: false, mediaIds: [],
      pages: 0, observed: 0, added: 0, omitted: 0, excluded: 0, oldestMs: null, newestMs: null,
      reason: null, notBefore: null, createdAt: now, updatedAt: now };
    this.store.saveArchiveFetch(job); this.launch(job.id); return job.id;
  }
  resume(id: string) {
    const job = this.store.archiveFetch(id);
    if (!job || job.state !== 'paused') throw new Error('Choose a paused archive fetch');
    if (!this.store.followedSources().includes(job.subreddit)) throw new Error('Subscribe to this subreddit before resuming');
    this.allowed(true);
    this.store.saveArchiveFetch({ ...job, state: 'running', reason: null, notBefore: null, updatedAt: Date.now() });
    this.launch(id);
  }
  pause(reason = 'Stopped by user; Resume to continue', source?: string) {
    const job = this.active;
    if (!job || job.state !== 'running' || (source && job.subreddit !== source)) return;
    this.controller?.abort();
    this.store.saveArchiveFetch({ ...job, state: 'paused', reason, updatedAt: Date.now() });
  }
  async stop(source?: string, reason?: string) {
    if (source && this.active?.subreddit !== source) return;
    this.pause(reason, source); await this.completion;
  }
  async close(reason='Application stopped; Resume to continue') { await this.stop(undefined,reason); }
  private launch(id: string) {
    this.deps.onRunStart?.();
    this.activeId = id; this.controller = new AbortController();
    this.completion = this.run(id, this.controller.signal).finally(() => { this.activeId = null; this.controller = null; this.completion = null; });
  }
  private async response(url: URL, signal: AbortSignal): Promise<unknown[]> {
    return this.deps.queue.run(async () => {
      signal.throwIfAborted();this.deps.queue.assertOnline(); this.store.assertStorageAvailable(); this.requests++;
      const response = await (this.deps.fetch ?? fetch)(url, { signal: AbortSignal.any([signal,this.deps.queue.signal, AbortSignal.timeout(60_000)]),
        redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/json' } });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 429) {
          const now = Date.now();
          const seconds = Number(response.headers.get('x-ratelimit-reset'));
          const rawResetAt = Number(response.headers.get('x-ratelimit-reset-at'));
          const resetAt = rawResetAt < 1_000_000_000_000 ? rawResetAt * 1000 : rawResetAt;
          const candidates = [retryAfter(response.headers.get('retry-after'), now) ?? 0,
            Number.isFinite(seconds) && seconds > 0 ? now + Math.ceil(seconds * 1000) : 0,
            Number.isFinite(resetAt) && resetAt > now ? resetAt : 0];
          // Missing reset headers never cause an immediate retry loop.
          this.store.setSetting('archiveCooldown', Math.max(now + 60_000, ...candidates.filter(value=>Number.isSafeInteger(value)&&value<=8_640_000_000_000_000)));
        }
        throw new Error(`Archive service returned HTTP ${response.status}; fetch paused. Resume explicitly when available.`);
      }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
        await response.body?.cancel(); throw new Error('Archive service returned an unsupported response; fetch paused');
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
        await response.body.cancel(); throw new Error('Archive page is too large to process safely; checkpoint kept');
      }
      const decoder = new TextDecoder('utf-8', { fatal: true }); let body = '', bytes = 0;
      for await (const chunk of response.body) {
        signal.throwIfAborted(); bytes += chunk.length;
        if (bytes > MAX_RESPONSE) throw new Error('Archive page is too large to process safely; checkpoint kept');
        body += decoder.decode(chunk, { stream: true });
      }
      body += decoder.decode(); signal.throwIfAborted();
      const result = JSON.parse(body);
      if (result?.error || !Array.isArray(result?.data)) throw new Error('Archive query failed or its response format changed; checkpoint kept');
      if (result.data.length > 1000) throw new Error('Archive service exceeded the supported page size; checkpoint kept');
      return result.data;
    }, signal);
  }
  private async run(id: string, signal: AbortSignal) {
    const generation = this.store.generation, initial = this.store.archiveFetch(id)!;
    const revision = this.store.sourceRevision(initial.subreddit);
    const current = () => {
      signal.throwIfAborted();
      const job = this.store.archiveFetch(id);
      if (!job || job.state !== 'running' || generation !== this.store.generation || revision !== this.store.sourceRevision(job.subreddit)
        || !this.store.followedSources().includes(job.subreddit)) throw new Error('Archive content was stopped, removed or cleared');
      return job;
    };
    try {
      while (true) {
        let job = current(); this.store.assertStorageAvailable();
        if (job.phase === 'media') {
          await this.deps.saveMedia(job.mediaIds, signal); job = current();
          job = { ...job, phase: 'fetching', mediaIds: [], updatedAt: Date.now() };
          this.store.saveArchiveFetch(job);
        }
        if (job.dataComplete || job.cursorMs >= job.beforeMs) {
          this.store.saveArchiveFetch({ ...job, state: 'done', dataComplete: true, reason: 'Date range processed. Archive coverage and media availability may have gaps.', updatedAt: Date.now() });
          return;
        }
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({ subreddit: job.subreddit, after: new Date(Math.max(0, job.cursorMs - 1)).toISOString(),
          before: new Date(job.beforeMs).toISOString(), sort: 'asc', limit: job.widePage ? 'auto' : String(PAGE_LIMIT) }).toString();
        const rows = await this.response(url, signal); job = current();
        const records: PostObservation[] = [], boundary = new Set(job.boundaryIds), ids = new Set<string>();
        let omitted = 0, excluded = 0, observed = 0, last = job.cursorMs, previous = -1;
        for (const row of rows) {
          // Identity, order and timestamp are required even for an otherwise malformed record.
          if (!row || typeof row !== 'object' || typeof (row as any).id !== 'string' || typeof (row as any).created_utc !== 'number'
            || !Number.isSafeInteger((row as any).created_utc) || (row as any).created_utc < 0
            || subredditName(String((row as any).subreddit)) !== job.subreddit) throw new Error('Archive page has invalid identities or dates; checkpoint kept');
          const recordId = postId((row as any).id), ms = (row as any).created_utc * 1000;
          if (!Number.isSafeInteger(ms) || ms < job.cursorMs || ms > job.beforeMs || ms < previous) throw new Error('Archive page left its requested date range or ordering; checkpoint kept');
          previous = ms;
          if (ms === job.beforeMs) continue; // Defend against inclusive upstream end bounds.
          last = ms;
          if (ids.has(recordId) || (ms === job.cursorMs && boundary.has(recordId))) continue;
          ids.add(recordId); observed++;
          if (this.store.isPostExcluded(recordId)) { excluded++; continue; }
          try { records.push(archivePost(row as Record<string, any>, job.subreddit, id, Date.now())); } catch { omitted++; }
        }
        const full = job.widePage || rows.length >= PAGE_LIMIT;
        const stalled = rows.length > 0 && last === job.cursorMs && full;
        const sameBoundary = last === job.cursorMs ? job.boundaryIds : [];
        const nextBoundary = [...new Set([...sameBoundary, ...rows.filter(row => (row as any).created_utc * 1000 === last).map(row => postId((row as any).id))])];
        const dataComplete = rows.length === 0 || (previous >= job.beforeMs);
        const denseFailure = stalled && job.widePage;
        const updated: ArchiveFetchState = { ...job, pages: job.pages + 1, observed: job.observed + observed,
          omitted: job.omitted + omitted, excluded: job.excluded + excluded,
          cursorMs: full ? last : last + 1000, boundaryIds: full ? nextBoundary : [], widePage: stalled,
          dataComplete, phase: 'media', mediaIds: records.map(record => record.id),
          oldestMs: records.length ? Math.min(job.oldestMs ?? Infinity, ...records.map(record => record.created.epochMs)) : job.oldestMs,
          newestMs: records.length ? Math.max(job.newestMs ?? 0, ...records.map(record => record.created.epochMs)) : job.newestMs,
          updatedAt: Date.now(), reason: null };
        // Content, counters and next cursor are one transaction, including skipped-only pages.
        this.store.commitArchiveFetch(generation, revision, updated, records);
        if(omitted)this.deps.problems?.({operation:'archive-records',code:'archive-records',feed:job.subreddit,checkpoint:id,url:ENDPOINT,occurrences:omitted,facts:{rows:rows.length,accepted:records.length,rejected:omitted}},new Error('Invalid archive records'));
        if (denseFailure) throw new Error('Too many posts share one timestamp to advance safely. Partial data saved; use a bulk archive for this range.');
      }
    } catch (error) {
      if(!signal.aborted)this.deps.problems?.({operation:'archive-page',feed:initial.subreddit,checkpoint:id,url:ENDPOINT},error);
      const job = this.store.archiveFetch(id);
      if (job?.state === 'running') this.store.saveArchiveFetch({ ...job, state: 'paused',
        reason: error instanceof Error ? error.message : 'Archive fetch interrupted; Resume to continue',
        notBefore: this.store.getSetting<number>('archiveCooldown'), updatedAt: Date.now() });
    }
  }
}
