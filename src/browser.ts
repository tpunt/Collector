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
import {tumblrUrl,tumblrResourceAllowed,tumblrContentUrl} from './sources.ts';
import {join} from 'node:path';

export class AccessError extends Error {
  readonly notBefore: number | null;
  readonly platform:'reddit'|'tumblr'|undefined;
  constructor(reason: string, notBefore: number | null = null,platform?:'reddit'|'tumblr') { super(reason); this.notBefore = notBefore;this.platform=platform; }
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
  private lifecycle=0;
  private platform:'reddit'|'tumblr'='reddit';
  private tumblrBlog:string|null=null;
  private tumblrNavigation:string|null=null;
  get mediaCandidates() { return [...this.observedMedia]; }

  constructor(onAccess: (error: AccessError) => void = () => {}, queue?: RequestQueue) {
    this.onAccess = onAccess; this.queue = queue ?? new RequestQueue({fromCompletion:true});
    this.requestCounts.intervalMs = this.queue.intervalMs;
  }
  get counts() { return this.gate?.counts ?? this.requestCounts; }

  async open(maxRequests = 100, interactive: boolean | 'media' | 'tumblr' = false): Promise<void> {
    this.queue.assertOnline();
    const platform=interactive==='tumblr'?'tumblr':'reddit';
    if (this.context) { if(!this.failure&&this.platform===platform)return;await this.close(); }
    this.platform=platform;
    const lifecycle=this.lifecycle;
    const assertOpening=()=>{this.queue.assertOnline();if(lifecycle!==this.lifecycle)throw new Error('Collection browser opening was cancelled');};
    if (this.closing) await this.closing;
    const wait = Math.max(0, this.lastClosed + 5_000 - Date.now());
    if (wait) await delay(wait,undefined,{signal:this.queue.signal});
    assertOpening();
    this.failure = null;
    this.observedMedia.clear();
    this.limiter = new BrowserLimiter();
    const profile=platform==='tumblr'?join(profileDirectory,'..','tumblr-browser-profile'):profileDirectory;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const { chromium } = await import('playwright');
    assertOpening();
    const context = await chromium.launchPersistentContext(profile, {
      ...browserLaunchOptions, channel: process.env.REDDIT_READER_BROWSER_CHANNEL ?? 'chrome',
      headless: false, javaScriptEnabled: Boolean(interactive)&&interactive!=='tumblr', viewport: { width: 1280, height: 900 },
    });
    this.context = context;
    if(this.queue.offline||lifecycle!==this.lifecycle){await this.close();assertOpening();}
    try {
    this.page = context.pages()[0] ?? await context.newPage();
    assertOpening();
    this.page.setDefaultNavigationTimeout(30_000);
    this.page.setDefaultTimeout(10_000);
    context.on('response', response => {
      const status = response.status();
      if (status === 429 || (status === 403 && response.request().isNavigationRequest())) {
        const error = new AccessError(status === 429 ? `${platform==='tumblr'?'Tumblr':'Reddit'} returned 429; collection stopped` : `${platform==='tumblr'?'Tumblr':'Reddit'} denied access (403)`, retryAfter(response.headers()['retry-after']),platform);
        this.failure = error;
        this.limiter.pause(error.message, error.notBefore);
        this.gate?.stop();
        this.onAccess(error);
        void this.close().catch(()=>{});
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    assertOpening();const control=await chromiumControlUrl(profile);assertOpening();
    const current=()=>lifecycle===this.lifecycle&&this.context===context&&!this.queue.offline;
    const gate = await ChromiumRequestGate.install(control, {
      queue: this.queue,
      onMediaRequest: interactive==='media' ? url=>this.observedMedia.add(url) : undefined,
      // Media controls need Reddit's scripts, not unrelated embeds or tracking.
      allowResource:interactive==='tumblr'?(input,type)=>tumblrResourceAllowed(input,type,this.tumblrBlog,this.tumblrNavigation??undefined):interactive==='media'?url=>{try{const host=new URL(url).hostname;return ['reddit.com','old.reddit.com','www.reddit.com'].includes(host)||host==='redditstatic.com'||host.endsWith('.redditstatic.com')||host==='redditmedia.com'||host.endsWith('.redditmedia.com');}catch{return false;}}:undefined,
      blockedResourceTypes: interactive === 'media' ? ['Image', 'Media', 'Font', 'Ping', 'Other'] : interactive&&interactive!=='tumblr' ? [] : ['Image', 'Media', 'Font', 'Script', 'XHR', 'Fetch', 'Ping', 'Other'], maxRequests,
      isPaused: () => this.failure !== null||this.queue.offline,
      onBudget: () => { if(!current())return;const error = new AccessError('Website request budget reached; Continue explicitly to fetch more'); this.failure = error; this.onAccess(error); void this.close().catch(()=>{}); },
      onFailure: () => { if(!current())return;const error = new AccessError('Browser request control failed; collection stopped'); this.failure = error; this.onAccess(error); void this.close().catch(()=>{}); },
    });
    if(!current()){gate.stop();await context.close();gate.disposeAfterBrowserClose();assertOpening();}
    this.gate=gate;
    }catch(error){if(this.context===context)await this.close();throw error;}
  }

  async manualSignIn() {
    this.queue.assertOnline();
    await this.close();
    await this.open(150, true);
    await this.page!.goto('https://www.reddit.com/login/', { waitUntil: 'commit', timeout: 180_000 });
  }

  async navigate(urlInput: string, signal?: AbortSignal): Promise<Page> {
    this.queue.assertOnline();
    const tumblr=this.platform==='tumblr';
    const blog=tumblr?(new URL(urlInput).hostname==='www.tumblr.com'?this.tumblrBlog:new URL(urlInput).hostname.split('.')[0]!):null;
    const url = tumblr?tumblrContentUrl(urlInput,blog!):redditUrl(urlInput);
    if(tumblr){this.tumblrBlog=blog;this.tumblrNavigation=url.href;}
    if (!tumblr&&(url.hostname !== 'old.reddit.com' || url.pathname.endsWith('.json'))) throw new Error('Collector requires a Classic Reddit page');
    if (!this.page) await this.open();
    const page = this.page!;
    try {
      await this.limiter.run('navigation', async () => {
        signal?.throwIfAborted();
        // CSS determines rendered visibility. Drain paced resources before Next;
        // otherwise requests from the previous page can starve the next navigation.
        // A paced 120-request session can legitimately take ten minutes.
        await page.goto(url.href, { waitUntil: 'load', timeout: 600_000 });
        await page.locator('#header, main, h1, form, article, [data-post-id], .post, .no-posts, video, .photoset, .photoset_row').first().waitFor({ state: 'attached', timeout: 15_000 });
      }, signal);
      if (this.failure) throw this.failure;
      if(tumblr){tumblrContentUrl(page.url(),blog!);return page;}
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
    this.lifecycle++;
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
