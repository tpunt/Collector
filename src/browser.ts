import './browser-path.ts';
import { mkdir } from 'node:fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { browserLaunchOptions } from './browser-options.ts';
import { profileDirectory } from './paths.ts';
import { BrowserLimiter, retryAfter } from './limiter.ts';
import { ChromiumRequestGate, chromiumControlUrl, RequestQueue } from './request-gate.ts';
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
  private requestCounts = { intercepted: 0, released: 0, aborted: 0, suppressed: 0, intervalMs: 5_000 };
  private onAccess: (error: AccessError) => void;
  private queue: RequestQueue | undefined;
  private observedMedia = new Set<string>();
  get mediaCandidates() { return [...this.observedMedia]; }

  constructor(onAccess: (error: AccessError) => void = () => {}, queue?: RequestQueue) { this.onAccess = onAccess; this.queue = queue; }
  get counts() { return this.gate?.counts ?? this.requestCounts; }

  async open(maxRequests = 100, interactive: boolean | 'media' = false): Promise<void> {
    if (this.context) return;
    if (this.closing) await this.closing;
    const wait = Math.max(0, this.lastClosed + 5_000 - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    this.failure = null;
    this.observedMedia.clear();
    this.limiter = new BrowserLimiter();
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    const { chromium } = await import('playwright');
    const context = await chromium.launchPersistentContext(profileDirectory, {
      ...browserLaunchOptions, channel: process.env.REDDIT_READER_BROWSER_CHANNEL ?? 'chrome',
      headless: false, javaScriptEnabled: Boolean(interactive), viewport: { width: 1280, height: 900 },
    });
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
        void this.close();
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    this.gate = await ChromiumRequestGate.install(await chromiumControlUrl(profileDirectory), {
      queue: this.queue,
      onMediaRequest: interactive==='media' ? url=>this.observedMedia.add(url) : undefined,
      blockedResourceTypes: interactive === 'media' ? ['Image', 'Media', 'Font', 'Ping', 'Other'] : interactive ? [] : ['Image', 'Media', 'Font', 'Script', 'XHR', 'Fetch', 'Ping', 'Other'], maxRequests,
      isPaused: () => this.failure !== null,
      onBudget: () => { const error = new AccessError('Website request budget reached; Continue explicitly to fetch more'); this.failure = error; this.onAccess(error); void this.close(); },
      onFailure: () => { const error = new AccessError('Browser request control failed; collection stopped'); this.failure = error; this.onAccess(error); void this.close(); },
    });
  }

  async manualSignIn() {
    await this.close();
    await this.open(150, true);
    await this.page!.goto('https://www.reddit.com/login/', { waitUntil: 'commit', timeout: 180_000 });
  }

  async navigate(urlInput: string, signal?: AbortSignal): Promise<Page> {
    const url = redditUrl(urlInput);
    if (url.hostname !== 'old.reddit.com' || url.pathname.endsWith('.json')) throw new Error('Collector requires a Classic Reddit page');
    if (!this.page) await this.open();
    const page = this.page!;
    try {
      await this.limiter.run('navigation', async () => {
        signal?.throwIfAborted();
        // CSS determines rendered visibility. Drain paced resources before Next;
        // otherwise requests from the previous page can starve the next navigation.
        await page.goto(url.href, { waitUntil: 'load', timeout: 180_000 });
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
      await context.close().catch(() => undefined);
      gate?.disposeAfterBrowserClose();
      this.requestCounts = gate?.counts ?? this.requestCounts;
      this.gate = null; this.lastClosed = Date.now(); this.closing = null;
    })();
    return this.closing;
  }
}
