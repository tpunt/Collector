import type { Page } from 'playwright';
import { absoluteTime, canonicalPostUrl, postId, redditUrl, subredditName, validateObservation } from './domain.ts';
import type { MediaKind, PostObservation, Availability } from './domain.ts';
import { mediaReferences, postMediaReferences,isGallery } from './media-reference.ts';
import type { MediaReference } from './media-reference.ts';
import {PostIdentityError,ExtractionError} from './sync-errors.ts';
import {onlineEmbed} from './online-embed.ts';
import {redditDomAuthor} from './reddit-author.ts';
import type {Author} from './authors.ts';

export interface RawPost {
  id: string | null; subreddit: string | null; permalink: string | null;
  title: string; datetime: string | null; outbound: string | null;
  self: boolean; pinned: boolean; promoted: boolean; body?: string;
  video: boolean; image: boolean;
  assets?: string[];
  author?:{name:string;href:string|null};
}
export interface Listing {
  unavailableIds?:string[];
  account: string;
  posts: PostObservation[];
  ordinary: { id: string; createdMs: number; precisionMs: number }[];
  unknownTime: boolean;
  omissions: number;
  next: string | null;
  empty: boolean;
  signature: string;
}

/** Runs in the page. Only attached rendered DOM and scalar attributes; never script/hydration state. */
export function collectClassicListingDom() {
  function rendered(el: Element | null): el is Element {
    if (!el?.isConnected || el.closest('template, [hidden], [inert], [aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.getClientRects().length > 0;
  }
  const accountLink = Array.from(document.querySelectorAll('#header .user a')).find(el => rendered(el) && /\/user\//.test(el.getAttribute('href') ?? ''));
  const table = document.querySelector('#siteTable');
  // A missing ID is an extraction failure, rather than a card to silently hide.
  const rows = Array.from(table?.querySelectorAll(':scope > .thing')??[]).filter(rendered);
  const posts: RawPost[] = rows.map(el => {
    const title = el.querySelector('a.title');
    const time = el.querySelector('.tagline time:not(.edited-timestamp)');
    const body = el.querySelector(':scope > .entry .usertext-body .md');
    const author=el.querySelector(':scope > .entry .tagline .author');
    const tagline=el.querySelector(':scope > .entry .tagline');
    return {
      id: el.getAttribute('data-fullname'), subreddit: el.getAttribute('data-subreddit'),
      permalink: el.getAttribute('data-permalink') ?? el.querySelector('a.comments')?.getAttribute('href') ?? null,
      title: rendered(title) ? (title.textContent ?? '').trim() : '',
      author:rendered(author)?{name:(author.textContent??'').trim(),href:author.getAttribute('href')}:rendered(tagline)&&/\bby\s+\[deleted\]/i.test((tagline as HTMLElement).innerText)?{name:'[deleted]',href:null}:undefined,
      datetime: rendered(time) ? time.getAttribute('datetime') : null,
      outbound: el.getAttribute('data-url') ?? title?.getAttribute('href') ?? null,
      self: el.classList.contains('self'), pinned: el.classList.contains('stickied'),
      promoted: el.classList.contains('promoted') || el.getAttribute('data-promoted') === 'true',
      body: rendered(body) ? (body as HTMLElement).innerText.trim() : undefined,
      video: Array.from(el.querySelectorAll('video')).some(rendered),
      image: Array.from(el.querySelectorAll('.expando img, .media-preview img')).some(rendered),
      assets: Array.from(el.querySelectorAll('.expando img, .media-preview img, .usertext-body img, video')).filter(rendered)
        .flatMap(node => [node.closest('a')?.getAttribute('href')??node.getAttribute('src'), node.tagName === 'VIDEO' ? node.querySelector('source')?.getAttribute('src') : null])
        .filter((url): url is string => Boolean(url)),
    };
  });
  const sibling=table?.nextElementSibling;
  const nextLinks=[...(table?.querySelectorAll('.next-button a')??[]),
    ...(sibling?.matches('.nav-buttons,.next-button')?sibling.querySelectorAll('.next-button a, :scope.next-button > a'):[])];
  const next = nextLinks.find(rendered);
  const noResults = table?.querySelector('.noresults');
  const empty = Boolean(rendered(noResults ?? null) && /there doesn.t seem to be anything here|no results/i.test(noResults!.textContent ?? ''));
  const blocked = !rows.length && /too many requests|you.ve been blocked|blocked by network security|verify you are human|security check/i.test(
    [document.title, ...Array.from(document.querySelectorAll('h1, [role="alert"], .error')).filter(rendered).map(el => el.textContent)].join(' '));
  return {
    account: accountLink?.textContent?.trim() ?? null, accountHref: accountLink?.getAttribute('href') ?? null,
    posts, next: next?.getAttribute('href') ?? null, empty, blocked,
    sort: document.querySelector('.tabmenu .selected')?.textContent?.trim().toLowerCase() ?? null,
  };
}

export function classifyMedia(row: Pick<RawPost, 'self' | 'body' | 'outbound' | 'video' | 'image'>): MediaKind[] {
  const media: MediaKind[] = [];
  if (row.self || Boolean(row.body?.trim())) media.push('Text');
  let url: URL | null = null;
  try { if (row.outbound) url = new URL(row.outbound, 'https://www.reddit.com'); } catch { /* Unknown evidence. */ }
  if (row.video || onlineEmbed(url?.href) || url?.hostname === 'v.redd.it' || (url && /\.(mp4|webm|mov)$/i.test(url.pathname))) media.push('Video');
  const gallery = url && ['www.reddit.com','reddit.com','old.reddit.com'].includes(url.hostname) && /^\/gallery\/[a-z0-9]+\/?$/i.test(url.pathname);
  if ((row.image && url?.hostname!=='v.redd.it') || gallery || url?.hostname === 'i.redd.it' || (url && /\.(png|jpe?g|gif|webp|avif)$/i.test(url.pathname))) media.push('Image');
  if (!media.length && url && /^https?:$/.test(url.protocol) && !['reddit.com', 'www.reddit.com', 'old.reddit.com'].includes(url.hostname)) media.push('Link');
  return media.length ? media : ['Unknown'];
}

export function validateNext(input: string | null, subreddit: string): string | null {
  if (!input) return null;
  let url:URL;try{url=redditUrl(input);}catch{throw new ExtractionError('pagination','Pagination left the selected subreddit/new listing');}
  if (url.hostname !== 'old.reddit.com' || url.hash || !new RegExp(`^/r/${subredditName(subreddit)}/new/?$`, 'i').test(url.pathname)) {
    throw new ExtractionError('pagination','Pagination left the selected subreddit/new listing');
  }
  return url.href;
}

export async function readListing(page: Page, input: string): Promise<Listing> {
  const subreddit = subredditName(input);
  const dom = await page.evaluate(collectClassicListingDom);
  const evidence={rows:dom.posts.length,selector:'#siteTable',emptyMarker:dom.empty,nextPresent:Boolean(dom.next)};
  if (dom.blocked) throw new ExtractionError('access','Reddit displayed an access or verification block',evidence);
  if (!dom.account || !/^[a-z0-9_-]{3,24}$/i.test(dom.account) || !dom.accountHref) throw new ExtractionError('access','Sign-in is unavailable; no rendered account header',{...evidence,missingFields:['account']});
  const accountLink = redditUrl(dom.accountHref);
  if (accountLink.pathname.replace(/\/$/, '').toLowerCase() !== `/user/${dom.account.toLowerCase()}`) throw new Error('Account header identity is inconsistent');
  if (dom.sort !== 'new') throw new ExtractionError('listing-layout','Expected the subreddit’s New listing',{...evidence,missingFields:['sort']});
  if (!dom.posts.length && !dom.empty) throw new ExtractionError('listing-layout','Listing layout was not recognised; no explicit empty state',evidence);
  const posts: PostObservation[] = [];
  const ordinary: Listing['ordinary'] = [];
  let omissions = 0;
  let unknownTime = false;
  const missing=new Set<string>();
  const now = Date.now();
  for (const row of dom.posts) {
    if (row.promoted) continue;
    const created = row.datetime ? absoluteTime(row.datetime) : null;
    if(!created)missing.add('datetime');if(!row.id)missing.add('id');if(!row.permalink)missing.add('permalink');if(!row.subreddit)missing.add('subreddit');if(!row.title.trim())missing.add('title');
    if (!created && !row.pinned) unknownTime = true;
    try {
      if (!created || !row.id || !row.permalink || !row.subreddit || subredditName(row.subreddit) !== subreddit) throw new Error('Incomplete identity/time');
      const observation = validateObservation({ id: row.id, subreddit, title: row.title,
        author:redditDomAuthor(row.author),
        permalink: row.permalink, created, source: 'live', observedAt: now,
        body: row.body,bodyNeedsFetch:row.self||Boolean(row.body), outbound:row.outbound??undefined, media: classifyMedia(row), attachments:isGallery(row.outbound)?[]:postMediaReferences(row.outbound,mediaReferences([row.outbound, ...row.assets ?? []])) });
      posts.push(observation);
      if (!row.pinned) ordinary.push({ id: observation.id, createdMs: created.epochMs, precisionMs: created.precisionMs });
    } catch { omissions++; }
  }
  if(omissions)throw new ExtractionError('listing-records',`${omissions} post(s) could not be parsed; collection paused and page checkpoint kept for retry`,{...evidence,accepted:posts.length,rejected:omissions,missingFields:[...missing]});
  return { account: dom.account, posts, ordinary, unknownTime, omissions,
    next: validateNext(dom.next, subreddit), empty: dom.empty,
    signature: posts.map(post => post.id).join(',') };
}

export interface CommentRecord {
  id: string; postId: string; parentId: string | null; ancestry: 'known' | 'unresolved';
  body: string; availability: Availability; createdMs: number | null;
}
export interface ThreadSnapshot {
  id: string; postId: string; source: 'live' | 'archive'; capturedAt: number | null; observedAt: number;
  sort: string; body: string | null; availability: Availability; comments: CommentRecord[];
  omitted: number; sample: string; exportId?: string;
  author?:Author|null;
}

export function collectClassicThreadDom(expectedId: string) {
  function rendered(el: Element | null): el is Element {
    if (!el?.isConnected || el.closest('[hidden], [inert], template, [aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  const posts = Array.from(document.querySelectorAll('.thing[data-fullname^="t3_"]'))
    .filter(el=>rendered(el)&&!el.closest('.side,.gadget,.promoted,.commentarea'));
  const matches = posts.filter(el=>el.getAttribute('data-fullname')===expectedId);
  function removal(el:Element): 'removed'|'deleted'|null {
    const nodes=Array.from(el.querySelectorAll(':scope > .entry .title, :scope > .entry .usertext-body .md')).filter(rendered);
    for(const node of nodes){const text=(node as HTMLElement).innerText.trim();
      if(/^\[\s*removed(?: by (?:moderators?|reddit))?\s*\]$/i.test(text))return 'removed';
      if(/^\[\s*deleted\s*\]$/i.test(text))return 'deleted';
    }
    return null;
  }
  // Classic removes data-fullname from some moderator-removed OPs while keeping
  // their discussion. Require a matching canonical thread URL, a unique rendered
  // unlabelled post and an explicit removal marker before accepting that case.
  const threadUrl=location.hostname==='old.reddit.com'&&new RegExp(`^/r/[^/]+/comments/${expectedId.slice(3)}(?:/|$)`,'i').test(location.pathname);
  const removed = threadUrl && document.querySelector('.commentarea') ? Array.from(document.querySelectorAll('.thing.link:not([data-fullname])'))
    .filter(el=>rendered(el)&&!el.closest('.side,.gadget,.promoted,.commentarea')&&removal(el)) : [];
  const fallback=matches.length===0&&removed.length===1?removed[0]:null;
  const post = matches.length===1 ? matches[0] : fallback;
  const threadPostId=post?.getAttribute('data-fullname') ?? (fallback?expectedId:null);
  const body = post?.querySelector(':scope > .entry .usertext-body .md');
  const author=post?.querySelector(':scope > .entry .tagline .author');
  const tagline=post?.querySelector(':scope > .entry .tagline');
  const comments = Array.from(document.querySelectorAll('.commentarea .thing.comment[data-fullname^="t1_"]')).filter(rendered);
  return {
    postId: threadPostId,
    author:rendered(author??null)?{name:(author!.textContent??'').trim(),href:author!.getAttribute('href')}:rendered(tagline??null)&&/\bby\s+\[deleted\]/i.test((tagline as HTMLElement).innerText)?{name:'[deleted]',href:null}:undefined,
    availability: post?removal(post):null,
    visiblePostIds: posts.map(el=>el.getAttribute('data-fullname')),
    body: rendered(body ?? null) ? (body as HTMLElement).innerText.trim() : body&&body.textContent?.trim()===''&&rendered(body.parentElement)?'':null,
    bodyLinks:Array.from(body?.querySelectorAll('a[href]')??[]).filter(rendered).map(node=>({label:(node.textContent??'').trim(),href:node.getAttribute('href')})),
    assets: [post?.getAttribute('data-url'), ...Array.from(post?.querySelectorAll('a.title, .expando img, .media-preview img, video, .usertext-body a, .usertext-body img') ?? []).filter(rendered)
      .flatMap(node => [node.getAttribute('href'), node.closest('a')?.getAttribute('href')??node.getAttribute('src'), node.tagName === 'VIDEO' ? node.querySelector('source')?.getAttribute('src') : null])],
    sort: document.querySelector('.commentarea .dropdown.lightdrop .selected')?.textContent?.trim().toLowerCase() ?? null,
    sorts: Array.from(document.querySelectorAll('.commentarea .drop-choices a')).filter(rendered).map(el => ({ text: el.textContent?.trim().toLowerCase(), href: el.getAttribute('href') })),
    comments: comments.slice(0, 100).map(el => {
      const text = el.querySelector(':scope > .entry > .usertext .usertext-body .md');
      const ancestor = el.parentElement?.closest('.thing.comment[data-fullname^="t1_"]');
      const parent = el.getAttribute('data-parent') ?? ancestor?.getAttribute('data-fullname') ?? (el.parentElement?.closest('.commentarea > .sitetable') ? threadPostId : null);
      const time = el.querySelector(':scope > .entry .tagline time:not(.edited-timestamp)');
      return { id: el.getAttribute('data-fullname'), parent: parent ?? null,
        body: rendered(text) ? (text as HTMLElement).innerText.trim() : null,
        datetime: rendered(time) ? time.getAttribute('datetime') : null };
    }),
    omitted: Math.max(0, comments.length - 100) + document.querySelectorAll('.commentarea .morechildren').length,
  };
}

export async function readThread(page: Page, expectedId: string): Promise<{ snapshot: ThreadSnapshot; topLink: string | null; attachments?: MediaReference[] }> {
  const id = postId(expectedId);
  const dom = await page.evaluate(collectClassicThreadDom,id);
  if (!dom.postId || postId(dom.postId) !== id) throw new PostIdentityError(id,dom.visiblePostIds,page.url());
  const comments: CommentRecord[] = [];
  let omitted = dom.omitted;
  for (const row of dom.comments) {
    if (!row.id || !/^t1_[a-z0-9]+$/.test(row.id) || row.body === null) { omitted++; continue; }
    const parent = row.parent && /^(t1|t3)_[a-z0-9]+$/.test(row.parent) ? row.parent : null;
    const marker = row.body.trim();
    const availability = marker === '[deleted]' ? 'deleted' : marker === '[removed]' ? 'removed' : 'available';
    comments.push({ id: row.id, postId: id, parentId: parent, ancestry: parent ? 'known' : 'unresolved',
      body: availability === 'available' ? row.body : '', availability,
      createdMs: row.datetime ? absoluteTime(row.datetime)?.epochMs ?? null : null });
  }
  const marker = dom.body?.trim();
  const availability = dom.availability ?? (marker === '[deleted]' ? 'deleted' : marker === '[removed]' ? 'removed' : 'available');
  let body=dom.body;
  if(body!==null&&availability==='available'){
    const links=new Map<string,string>();
    for(const link of dom.bodyLinks??[]){try{const url=new URL(link.href??'',page.url());if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!body.includes(url.href))links.set(url.href,link.label);}catch{/* Invalid links are not executable content. */}}
    if(links.size)body+='\n\nLinks:\n'+[...links].map(([url,label])=>label&&label!==url?`${label}: ${url}`:url).join('\n');
  }
  const top = dom.sorts.find(sort => sort.text === 'top')?.href;
  let topLink: string | null = null;
  if (top) {
    const url = redditUrl(top);
    if (url.hostname === 'old.reddit.com' && /\/comments\//.test(url.pathname) && url.searchParams.get('sort') === 'top') topLink = url.href;
  }
  return { attachments:isGallery(dom.assets[0])?undefined:postMediaReferences(dom.assets[0],mediaReferences(dom.assets)), snapshot: { id: crypto.randomUUID(), postId: id, source: 'live', capturedAt: Date.now(), observedAt: Date.now(),
    author:redditDomAuthor(dom.author),
    sort: dom.sort ?? 'unknown', body: availability === 'available' ? body : null,
    availability, comments, omitted, sample: 'Initially rendered comments, up to 100; unexpanded branches omitted' }, topLink };
}
