import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Clock } from './limiter.ts';

export type RequestInterval = number | readonly [number, number];
export const DEFAULT_REQUEST_INTERVAL = [4_000, 6_000] as const;

/** Spaces network starts, including redirects; not merely UI actions. */
export class RequestQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAllowedAt: number | null = null;
  private controller = new AbortController();
  private access = new AbortController();
  private offlineMode = false;
  private clock: Clock;
  private fromCompletion: boolean;
  private random: () => number;
  readonly intervalMs: RequestInterval;
  released = 0;

  constructor(options: { intervalMs?: RequestInterval; clock?: Clock; fromCompletion?: boolean; random?: () => number } = {}) {
    this.intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : [...(options.intervalMs ?? DEFAULT_REQUEST_INTERVAL)] as [number,number];
    this.fromCompletion = options.fromCompletion ?? false;
    const [min,max] = typeof this.intervalMs === 'number' ? [this.intervalMs,this.intervalMs] : this.intervalMs;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) throw new Error('Invalid request interval');
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? { now: () => performance.now(), sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };
  }
  stop(): void { this.controller.abort(); }
  get offline(){return this.offlineMode;}
  get signal(){return this.access.signal;}
  assertOnline(){if(this.offlineMode)throw new Error('Offline mode is on; external requests are paused');}
  setOffline(value:boolean){
    if(value===this.offlineMode)return;
    this.offlineMode=value;
    if(value)this.access.abort();else this.access=new AbortController();
  }
  private sampleInterval(): number {
    if (typeof this.intervalMs === 'number') return this.intervalMs;
    const [min,max] = this.intervalMs;
    if (min === max) return min;
    const sample = this.random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error('Invalid request interval sample');
    return min + sample * (max - min);
  }
  private async waitUntil(deadline:number, signal?:AbortSignal):Promise<void> {
    const combined = AbortSignal.any([...(signal?[signal]:[]),this.controller.signal,this.access.signal]);
    this.assertOnline();
    combined.throwIfAborted();
    while (this.clock.now() < deadline) await this.clock.sleep(deadline-this.clock.now(),combined);
    combined.throwIfAborted();
  }
  /** Between HTTP hops within a composite media task, while it holds the queue. */
  async waitInterval(signal?:AbortSignal):Promise<void> {
    await this.waitUntil(this.clock.now()+this.sampleInterval(),signal);
  }
  run<T>(release: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if(this.offlineMode)return Promise.reject(new Error('Offline mode is on; external requests are paused'));
    const access=this.access.signal;
    const task = this.tail.then(async () => {
      access.throwIfAborted();this.assertOnline();
      signal?.throwIfAborted();
      this.controller.signal.throwIfAborted();
      if (this.nextAllowedAt !== null) await this.waitUntil(this.nextAllowedAt,signal);
      access.throwIfAborted();this.assertOnline();
      const startedAt = this.clock.now();
      this.released++;
      try { return await release(); }
      // Sample once per completed release, so cancelled waiters cannot shorten it.
      finally { this.nextAllowedAt = (this.fromCompletion ? this.clock.now() : startedAt) + this.sampleInterval(); }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}

/** Local Chromium control metadata, not account/profile contents. Never expose this URL in logs/UI. */
export async function chromiumControlUrl(profile: string): Promise<string> {
  const [portText, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-f0-9-]+$/.test(path ?? '')) {
    throw new Error('Invalid local Chromium control endpoint');
  }
  return `ws://127.0.0.1:${port}${path}`;
}

interface Message {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  error?: { message: string };
  result?: unknown;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface RequestGateOptions {
  queue?: RequestQueue;
  onMediaRequest?: (url: string) => void;
  intervalMs?: RequestInterval;
  isPaused?: () => boolean;
  onFailure?: (reason: string,code:string) => void;
  blockedResourceTypes?: string[];
  allowResource?: (url:string,type:string)=>boolean;
  maxRequests?: number;
  onBudget?: () => void;
}

/** Browser request-stage interception: no response bodies, headers, post data or content extraction. */
export class ChromiumRequestGate {
  private socket: WebSocket;
  private queue: RequestQueue;
  private ownsQueue: boolean;
  private controller = new AbortController();
  private pending = new Map<number, Pending>();
  private responses = new Map<string, {resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private queuedRequests=new Map<string,number>();
  private cancelledRequests=new Set<string>();
  private setups = new Set<Promise<void>>();
  private nextId = 0;
  private stopped = false;
  private fault: Error | null = null;
  private intercepted = 0;
  private released = 0;
  private aborted = 0;
  private suppressed = 0;
  private blockedTypes: Set<string>;
  private maxRequests: number;
  private onBudget: () => void;
  private isPaused: () => boolean;
  private onFailure: NonNullable<RequestGateOptions['onFailure']>;
  private onMediaRequest: RequestGateOptions['onMediaRequest'];
  private allowResource:RequestGateOptions['allowResource'];

  private constructor(socket: WebSocket, options: RequestGateOptions) {
    this.socket = socket;
    this.ownsQueue = !options.queue;
    this.queue = options.queue ?? new RequestQueue({ intervalMs: options.intervalMs, fromCompletion: true });
    this.isPaused = options.isPaused ?? (() => false);
    this.onFailure = options.onFailure ?? (() => {});
    this.onMediaRequest = options.onMediaRequest;
    this.allowResource=options.allowResource;
    this.blockedTypes = new Set(options.blockedResourceTypes ?? []);
    this.maxRequests = options.maxRequests ?? Infinity;
    this.onBudget = options.onBudget ?? (() => {});
    socket.addEventListener('message', event => this.receive(JSON.parse(String(event.data)) as Message));
    socket.addEventListener('close', () => {
      if (!this.stopped) this.onFailure('Browser request interception disconnected; browsing stopped','ERR_REQUEST_CONTROL_DISCONNECTED');
      this.stop();
    });
  }

  static async install(url: string, options: RequestGateOptions = {}): Promise<ChromiumRequestGate> {
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+$/.test(url)) throw new Error('Expected the app browser’s loopback endpoint');
    const socket = new WebSocket(url);
    const gate = new ChromiumRequestGate(socket, options);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Chromium control connection timed out')), 10_000);
        socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Chromium control connection failed')); }, { once: true });
      });
      await gate.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'page' }, { exclude: true }],
      });
      while (gate.setups.size) await Promise.all([...gate.setups]);
      if (gate.fault) throw gate.fault;
      return gate;
    } catch (error) { gate.stop(); throw error; }
  }

  get counts() {
    return { intercepted: this.intercepted, released: this.released, aborted: this.aborted, suppressed: this.suppressed, intervalMs: this.queue.intervalMs };
  }
  stop(): void {
    this.stopped = true;
    this.controller.abort();
    if (this.ownsQueue) this.queue.stop();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Request gate stopped'));
    }
    this.pending.clear();
    for (const entry of this.responses.values()) { clearTimeout(entry.timer); entry.reject(new Error('Request gate stopped')); }
    this.responses.clear();
    // Keep interception attached until the browser is closed: detaching would release stalled requests.
  }
  disposeAfterBrowserClose(): void { this.socket.close(); }

  private attach(session: string): void {
    const setup = (async () => {
      await this.send('Network.enable', {}, session);
      await this.send('Fetch.enable', { patterns: [
        { urlPattern: 'http*', requestStage: 'Request' },
        { urlPattern: 'http*', requestStage: 'Response' },
      ] }, session);
      // Owning frames intercept worker requests. Workers themselves have no Fetch domain.
      await this.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'iframe' }, { exclude: true }],
      }, session);
      await this.send('Runtime.runIfWaitingForDebugger', {}, session);
    })();
    this.setups.add(setup);
    void setup.catch(error => {
      if (!this.stopped) {
        this.fault = error instanceof Error ? error : new Error('Request interception failed');
        this.onFailure('Request interception failed; browsing stopped','ERR_REQUEST_INTERCEPTION_SETUP');
        this.stop();
      }
    }).finally(() => this.setups.delete(setup));
  }

  private receive(message: Message): void {
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    } else if (message.method === 'Target.attachedToTarget') {
      if (!this.stopped) this.attach(String(message.params!.sessionId));
    } else if (message.method === 'Network.responseReceived' || message.method === 'Network.loadingFailed' ||
        (message.method === 'Network.requestWillBeSent' && message.params?.redirectResponse)) {
      const key = `${message.sessionId}:${message.params!.requestId}`;
      if(message.method==='Network.loadingFailed'&&this.queuedRequests.has(key))this.cancelledRequests.add(key);
      const entry = this.responses.get(key);
      if (entry) { clearTimeout(entry.timer); this.responses.delete(key); entry.resolve(); }
    } else if (message.method === 'Fetch.requestPaused') {
      // Response-stage interception supplies lifecycle readiness even for redirect
      // hops and owning-frame worker requests. No body/header values are read.
      if (message.params!.responseStatusCode !== undefined || message.params!.responseErrorReason !== undefined) {
        const key = `${message.sessionId}:${message.params!.networkId}`;
        const entry = this.responses.get(key);
        if (entry) { clearTimeout(entry.timer); this.responses.delete(key); entry.resolve(); }
        void this.send('Fetch.continueResponse', { requestId: String(message.params!.requestId) }, message.sessionId).catch(() => {
          if (!this.stopped) { this.onFailure('Response control failed; collection stopped','ERR_REQUEST_RESPONSE_CONTROL'); this.stop(); }
        });
        return;
      }
      // Use only the opaque interception ID. Credentials/headers/post data are never inspected.
      this.intercepted++;
      const requestId = String(message.params!.requestId);
      const session = message.sessionId!;
      const mediaUrl = (message.params!.request as {url?: string} | undefined)?.url;
      if (this.onMediaRequest && mediaUrl && /^https:\/\/v\.redd\.it\/[a-z0-9]+\/[^/?]+\.(?:mp4|mpd)(?:\?|$)/i.test(mediaUrl)) {
        this.onMediaRequest(mediaUrl);
        this.suppressed++;
        void this.send('Fetch.failRequest', {requestId,errorReason:'BlockedByClient'},session).catch(()=>undefined);
        return;
      }
      if (this.blockedTypes.has(String(message.params!.resourceType)) || (this.allowResource&&!this.allowResource(mediaUrl??'',String(message.params!.resourceType)))) {
        this.suppressed++;
        void this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, session).catch(() => undefined);
        return;
      }
      const networkId=message.params!.networkId;
      const key=`${session}:${networkId}`;
      // Redirect hops can share a Network ID while their queue callbacks unwind.
      this.queuedRequests.set(key,(this.queuedRequests.get(key)??0)+1);
      void this.queue.run(async () => {
        if (this.stopped || this.isPaused()) throw new Error('Browsing paused');
        // A page can abort a fetch while it waits behind paced resources. Its
        // interception ID is then invalid. Explicit cancellation evidence lets
        // us discard that waiter without treating Chrome control as broken.
        if(this.cancelledRequests.has(key))throw new Error('Website cancelled the queued request');
        if (this.released >= this.maxRequests) { this.onBudget(); this.stop(); throw new Error('Request budget reached'); }
        if (!networkId) throw new Error('Request has no network lifecycle identity');
        const received = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.responses.delete(key);
            reject(new Error('Website response headers timed out'));
          }, 30_000);
          this.responses.set(key, { resolve, reject, timer });
        });
        try {
          await Promise.all([this.send('Fetch.continueRequest', { requestId }, session).then(() => { this.released++; }), received]);
        } catch (error) {
          if (!this.stopped&&!this.cancelledRequests.has(key)) { this.onFailure('Website request lifecycle failed; collection stopped',error instanceof Error&&error.message==='Website response headers timed out'?'ERR_REQUEST_HEADERS_TIMEOUT':'ERR_REQUEST_CONTINUE'); this.stop(); }
          throw error;
        } finally {
          const entry = this.responses.get(key);
          if (entry) { clearTimeout(entry.timer); this.responses.delete(key); entry.resolve(); }
        }
      }, this.controller.signal).catch(async () => {
        this.aborted++;
        await this.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, session).catch(() => undefined);
      }).finally(()=>{
        const remaining=(this.queuedRequests.get(key)??1)-1;
        if(remaining)this.queuedRequests.set(key,remaining);
        else{this.queuedRequests.delete(key);this.cancelledRequests.delete(key);}
      });
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.stopped && method !== 'Fetch.failRequest') return Promise.reject(new Error('Request gate stopped'));
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, sessionId })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}
