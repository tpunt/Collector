import './browser-path.ts';
import { mkdir } from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import type { BrowserContext, Page } from 'playwright';
import { browserLaunchOptions } from './browser-options.ts';
import { profileDirectory } from './paths.ts';
import { BrowserLimiter, retryAfter } from './limiter.ts';
import { ChromiumRequestGate, chromiumControlUrl, RequestQueue, DEFAULT_REQUEST_INTERVAL } from './request-gate.ts';
import type { RequestInterval } from './request-gate.ts';
import { redditUrl } from './domain.ts';

export class AccessError extends Error {
  readonly notBefore: number | null;
  constructor(reason: string, notBefore: number | null = null) { super(reason); this.notBefore = notBefore; }
}

export class ReaderBrowser {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private gate: ChromiumRequestGate | null = null;
  private failure: Error | null = null;
  private limiter = new BrowserLimiter();
  private closing: Promise<void> | null = null;
  private lastClosed = 0;
  private requestCounts = { intercepted: 0, released: 0, aborted: 0, suppressed: 0, intervalMs: DEFAULT_REQUEST_INTERVAL as RequestInterval };
  private onAccess: (error: AccessError) => void;
  private queue: RequestQueue;
  private observedMedia = new Set<string>();
  get mediaCandidates() { return [...this.observedMedia]; }

  constructor(onAccess: (error: AccessError) => void = () => {}, queue?: RequestQueue) {
    this.onAccess = onAccess; this.queue = queue ?? new RequestQueue({fromCompletion:true});
    this.requestCounts.intervalMs = this.queue.intervalMs;
  }
  get counts() { return this.gate?.counts ?? this.requestCounts; }

  async open(maxRequests = 100, interactive: boolean | 'media' = false): Promise<void> {
    this.queue.assertOnline();
    if (this.context) { if(this.failure)throw this.failure;return; }
    if (this.closing) await this.closing;
    const wait = Math.max(0, this.lastClosed + 5_000 - Date.now());
    if (wait) await delay(wait,undefined,{signal:this.queue.signal});
    this.queue.assertOnline();
    this.failure = null;
    this.observedMedia.clear();
    this.limiter = new BrowserLimiter();
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    const { chromium } = await import('playwright');
    this.queue.assertOnline();
    const context = await chromium.launchPersistentContext(profileDirectory, {
      ...browserLaunchOptions, channel: process.env.REDDIT_READER_BROWSER_CHANNEL ?? 'chrome',
      headless: false, javaScriptEnabled: Boolean(interactive), viewport: { width: 1280, height: 900 },
    });
    if(this.queue.offline){await context.close();this.queue.assertOnline();}
    this.context = context;
    this.page = context.pages()[0] ?? await context.newPage();
    this.page.setDefaultNavigationTimeout(30_000);
    this.page.setDefaultTimeout(10_000);
    context.on('response', response => {
      const status = response.status();
      if (status === 429 || (status === 403 && response.request().isNavigationRequest())) {
        const error = new AccessError(status === 429 ? 'Reddit returned 429; collection stopped' : 'Reddit denied access (403)', retryAfter(response.headers()['retry-after']));
        this.failure = error;
        this.limiter.pause(error.message, error.notBefore);
        this.gate?.stop();
        this.onAccess(error);
        void this.close().catch(()=>{});
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    this.gate = await ChromiumRequestGate.install(await chromiumControlUrl(profileDirectory), {
      queue: this.queue,
      onMediaRequest: interactive==='media' ? url=>this.observedMedia.add(url) : undefined,
      // Media controls need Reddit's scripts, not unrelated embeds or tracking.
      allowResource:interactive==='media'?url=>{try{const host=new URL(url).hostname;return ['reddit.com','old.reddit.com','www.reddit.com'].includes(host)||host==='redditstatic.com'||host.endsWith('.redditstatic.com')||host==='redditmedia.com'||host.endsWith('.redditmedia.com');}catch{return false;}}:undefined,
      blockedResourceTypes: interactive === 'media' ? ['Image', 'Media', 'Font', 'Ping', 'Other'] : interactive ? [] : ['Image', 'Media', 'Font', 'Script', 'XHR', 'Fetch', 'Ping', 'Other'], maxRequests,
      isPaused: () => this.failure !== null||this.queue.offline,
      onBudget: () => { const error = new AccessError('Website request budget reached; Continue explicitly to fetch more'); this.failure = error; this.onAccess(error); void this.close().catch(()=>{}); },
      onFailure: () => { const error = new AccessError('Browser request control failed; collection stopped'); this.failure = error; this.onAccess(error); void this.close().catch(()=>{}); },
    });
  }

  async manualSignIn() {
    this.queue.assertOnline();
    await this.close();
    await this.open(150, true);
    await this.page!.goto('https://www.reddit.com/login/', { waitUntil: 'commit', timeout: 180_000 });
  }

  async navigate(urlInput: string, signal?: AbortSignal): Promise<Page> {
    this.queue.assertOnline();
    const url = redditUrl(urlInput);
    if (url.hostname !== 'old.reddit.com' || url.pathname.endsWith('.json')) throw new Error('Collector requires a Classic Reddit page');
    if (!this.page) await this.open();
    const page = this.page!;
    try {
      await this.limiter.run('navigation', async () => {
        signal?.throwIfAborted();
        // CSS determines rendered visibility. Drain paced resources before Next;
        // otherwise requests from the previous page can starve the next navigation.
        // A paced 120-request session can legitimately take ten minutes.
        await page.goto(url.href, { waitUntil: 'load', timeout: 600_000 });
        await page.locator('#header, main, h1, form').first().waitFor({ state: 'attached', timeout: 15_000 });
      }, signal);
      if (this.failure) throw this.failure;
      const destination = redditUrl(page.url());
      if (destination.hostname !== 'old.reddit.com' || /\/login\/?/.test(destination.pathname)) {
        const error = new AccessError('Saved login is unavailable. Sign in manually in the dedicated browser, then Resume.');
        this.onAccess(error); throw error;
      }
      return page;
    } catch (error) {
      if (this.failure) throw this.failure;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const context = this.context;
    const gate = this.gate;
    if (!context) return;
    this.context = null; this.page = null;
    gate?.stop();
    this.closing = (async () => {
      try {
        await context.close();
        gate?.disposeAfterBrowserClose();
        this.requestCounts = gate?.counts ?? this.requestCounts;
        this.gate = null; this.lastClosed = Date.now();
      } catch(error) {
        // Retain stopped interception if Chrome did not close; detaching would release requests.
        this.context=context;this.failure=new Error('The collection browser could not close. Close its window before resuming.');
        throw error;
      } finally { this.closing=null; }
    })();
    return this.closing;
  }
}
