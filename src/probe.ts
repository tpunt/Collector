import './browser-path.ts';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { BrowserLimiter, BrowserPausedError, retryAfter } from './limiter.ts';
import { absoluteTime, subredditName } from './domain.ts';
import { ChromiumRequestGate, chromiumControlUrl } from './request-gate.ts';
import { browserLaunchOptions } from './browser-options.ts';
import { dataDirectory } from './paths.ts';

const args = process.argv.slice(2);
let headless = false;
let login = false;
let channel: 'chrome' | undefined;
let subreddit = 'python';
let layouts: ('classic' | 'modern')[] = ['classic', 'modern'];
let directory = dataDirectory;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--headless') headless = true;
  else if (arg === '--login') login = true;
  else if (arg === '--channel' && args[i + 1] === 'chrome') { channel = 'chrome'; i++; }
  else if (arg === '--subreddit' && args[i + 1]) subreddit = subredditName(args[++i]!);
  else if (arg === '--data-dir' && args[i + 1]) directory = args[++i]!;
  else if (arg === '--layout' && ['classic', 'modern'].includes(args[i + 1]!)) layouts = [args[++i] as 'classic' | 'modern'];
  else throw new Error(`Unknown or incomplete option: ${arg}`);
}
if (headless && login) throw new Error('Manual login requires the visible browser; omit --headless');
if (login && !stdin.isTTY) throw new Error('Run --login from an interactive terminal so you can confirm completion');

await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
const { chromium } = await import('playwright');
const profileMode = headless ? 'isolated-inventory' : 'interactive-session';
const profile = join(resolve(directory), headless ? 'inventory-profile' : 'browser-profile');
const context = await chromium.launchPersistentContext(profile, {
  ...browserLaunchOptions, headless, channel, viewport: { width: 1280, height: 900 },
  // Default Playwright Chromium, with no stealth flags or account/proxy rotation.
});
const page = context.pages()[0] ?? await context.newPage();
page.setDefaultNavigationTimeout(30_000);
page.setDefaultTimeout(10_000);
const limiter = new BrowserLimiter();
let requestGate: ChromiumRequestGate | undefined;
let httpRequestsObserved = 0;
let automatedNavigations = 0;
const documentStatuses: { status: number; host: string; path: string }[] = [];
context.on('request', request => { if (/^https?:/.test(request.url())) httpRequestsObserved++; });
context.on('response', response => {
  const url = new URL(response.url());
  const isDocument = response.request().isNavigationRequest() && response.frame() === page.mainFrame();
  if (isDocument) documentStatuses.push({ status: response.status(), host: url.hostname, path: url.pathname });
  if (response.status() === 429) {
    limiter.pause(`HTTP 429 from ${url.hostname}`, retryAfter(response.headers()['retry-after']));
    requestGate?.stop();
  } else if (isDocument && response.status() === 403) {
    limiter.pause('Reddit denied the document request (HTTP 403)');
    requestGate?.stop();
  }
});

/** Inventory only. No accepted post adapter, network content, hidden state or authenticated HTML logging. */
async function inventory() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([page.evaluate(() => {
    const elements: Element[] = [];
    let truncated = false;
    function walk(root: Document | ShadowRoot) {
      for (const element of root.querySelectorAll('*')) {
        if (elements.length >= 10_000) { truncated = true; return; }
        elements.push(element);
        if (element.shadowRoot) walk(element.shadowRoot);
      }
    }
    walk(document);
    function rendered(element: Element): boolean {
      if (!element.isConnected) return false;
      let ancestor: Element | null = element;
      while (ancestor) {
        if (ancestor.matches('[hidden], [inert], template, script, style, [aria-hidden="true"]')) return false;
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        const root = ancestor.getRootNode();
        ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      }
      return element.getClientRects().length > 0;
    }
    const visible = elements.filter(rendered);
    const hosts = visible.filter(el => el.matches('shreddit-post, .thing[data-fullname^="t3_"]'));
    const title = document.title.slice(0, 200);
    const headings = visible.filter(el => el.matches('h1, h2, [role="alert"]'))
      .slice(0, 8).map(el => (el.textContent ?? '').trim().slice(0, 250));
    const blockText = hosts.length ? '' : visible.filter(el => el.matches('p, [role="alert"]'))
      .slice(0, 20).map(el => (el.textContent ?? '').slice(0, 500)).join(' ');
    const challenge = (hosts.length === 0 && /blocked|network security|verify.{0,20}human|unusual traffic|rate.?limit|too many requests|security check/i.test([title, ...headings, blockText].join(' '))) ||
      visible.some(el => el.matches('iframe[src*="captcha"], iframe[src*="challenge"]'));
    const loginPage = /^\/(?:login|account\/login)\/?/.test(location.pathname);
    const times = visible.filter(el => el.matches('time[datetime]')).slice(0, 6)
      .map(el => ({ datetime: el.getAttribute('datetime'), label: (el.textContent ?? '').trim().slice(0, 100) }));
    const attributes = ['data-fullname', 'data-subreddit', 'post-id', 'post-type', 'content-href', 'created-timestamp'];
    return {
      url: `${location.origin}${location.pathname}`, title,
      headingSignals: hosts.length ? [] : headings, challenge, loginPage,
      renderedHostCount: hosts.length,
      hostSamples: hosts.slice(0, 3).map(el => ({
        tag: el.tagName.toLowerCase(),
        attributeNames: el.getAttributeNames(),
        fields: Object.fromEntries(attributes.filter(name => el.hasAttribute(name)).map(name => [name, el.getAttribute(name)!.slice(0, 500)])),
      })),
      commentLinkCount: visible.filter(el => el.matches('a[href*="/comments/"]')).length,
      times,
      imageElementCount: visible.filter(el => el.tagName === 'IMG').length,
      videoElementCount: visible.filter(el => el.tagName === 'VIDEO').length,
      nextLinks: visible.filter(el => el.matches('.next-button a, a[rel="next"]'))
        .slice(0, 3).map(el => ({ text: (el.textContent ?? '').trim().slice(0, 40), href: el.getAttribute('href') })),
      openShadowRootCount: elements.filter(el => el.shadowRoot).length,
      inventoryTruncated: truncated,
    };
    }), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('DOM inventory exceeded its 10-second bound')), 10_000);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const reports: unknown[] = [];
let userConfirmedLogin = false;
let report: Record<string, unknown> | undefined;
try {
  // No WebSocket/server connections or service-worker bypasses in this diagnostic mode.
  await context.routeWebSocket('**/*', socket => socket.close());
  requestGate = await ChromiumRequestGate.install(await chromiumControlUrl(profile), {
    isPaused: () => limiter.pauseState !== null,
    onFailure: reason => { limiter.pause(reason); void context.close(); },
  });
  if (login) {
    try {
      await limiter.run('navigation', async () => {
        automatedNavigations++;
        await page.goto('https://www.reddit.com/login/', { waitUntil: 'commit' });
        // With per-request pacing, login resources may take minutes. The user controls
        // this readiness step; do not close their browser on a short DOM timeout.
      });
    } catch (error) {
      if (!(error instanceof BrowserPausedError)) throw error;
      reports.push({ stage: 'login', paused: limiter.pauseState });
    }
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
      if (limiter.pauseState) {
        await terminal.question('Automatic browsing is paused. The dedicated browser stays open for manual inspection/sign-in. Press Enter to finish this probe; rerun explicitly after resolving access.\n');
      } else {
        await terminal.question('The login page may load slowly with random 4–6 second request gaps. Sign in manually, including MFA; press Enter here only when signed in.\n');
        userConfirmedLogin = true;
      }
    } finally { terminal.close(); }
    if (userConfirmedLogin) {
      const dom = await inventory();
      if (dom.challenge || dom.loginPage) {
        limiter.pause('Manual sign-in/access has not been verified; browsing paused');
        requestGate.stop();
      }
    }
  }
  for (const layout of layouts) {
    if (limiter.pauseState) break;
    const host = layout === 'classic' ? 'old.reddit.com' : 'www.reddit.com';
    try {
      await limiter.run('navigation', async () => {
        automatedNavigations++;
        await page.goto(`https://${host}/r/${subreddit}/new/`, { waitUntil: 'commit' });
        await page.locator('shreddit-post, .thing[data-fullname^="t3_"], h1, [role="alert"]').first()
          .waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined);
      });
    } catch (error) {
      if (!(error instanceof BrowserPausedError)) {
        reports.push({ layout, navigationError: error instanceof Error ? error.message.split('\n')[0] : 'Navigation failed' });
        // A transport failure is inconclusive. Do not retry or automatically switch layout.
        break;
      }
    }
    let dom;
    try { dom = await inventory(); }
    catch (error) {
      reports.push({ layout, inventoryError: error instanceof Error ? error.message : 'DOM inventory failed' });
      limiter.pause('DOM inventory failed; explicit investigation required');
      break;
    }
    if (dom.challenge) { limiter.pause('Rendered block or challenge page'); requestGate.stop(); }
    if (dom.loginPage) { limiter.pause('Login page encountered; manual session intervention needed'); requestGate.stop(); }
    reports.push({ layout, ...dom, times: dom.times.map(time => ({ ...time, parsed: time.datetime ? absoluteTime(time.datetime) : null })) });
    if (limiter.pauseState) break;
  }
  report = {
    purpose: 'Bounded DOM feasibility inventory; no feed collection',
    loginRequested: login, sessionValidation: userConfirmedLogin ? 'user-confirmed; programmatic validation and reuse unverified' : 'unverified',
    headless, profileMode, browserChannel: channel ?? 'bundled-chromium', subreddit, documentStatuses, reports,
    paused: limiter.pauseState,
    supportedAdapter: null,
    notYetVerified: ['authenticated session reuse', 'post and comment extraction', 'media classification', 'pagination and restart', 'reachable history depth'],
  };
  if (limiter.pauseState || !reports.length || reports.some(report => 'navigationError' in (report as object))) process.exitCode = 2;
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ABORT_ERR') {
    report = { purpose: 'Probe cancelled' };
    process.exitCode = 130;
  } else {
    report = { purpose: 'Probe failed', errorType: error instanceof Error ? error.name : 'UnknownError', paused: limiter.pauseState };
    process.exitCode = 1;
  }
} finally {
  requestGate?.stop();
  await context.close();
  requestGate?.disposeAfterBrowserClose();
  if (report) stdout.write(`${JSON.stringify({ ...report, automatedNavigations, httpRequestsObserved, requestGate: requestGate?.counts }, null, 2)}\n`);
}
