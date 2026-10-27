import { mediaReference } from './media-reference.ts';
import type { MediaReference } from './media-reference.ts';
export const MEDIA_KINDS = ['Text', 'Image', 'Video', 'Link', 'Unknown'] as const;
export type MediaKind = typeof MEDIA_KINDS[number];
export const MEDIA_FILTERS = ['Media', ...MEDIA_KINDS] as const;
export type MediaFilter = typeof MEDIA_FILTERS[number];
export type Availability = 'available' | 'deleted' | 'removed';

export interface CreatedTime {
  epochMs: number;
  precisionMs: number;
}

export interface PostObservation {
  id: string;
  subreddit: string;
  title: string;
  permalink: string;
  created: CreatedTime;
  source: 'live' | 'archive';
  exportId?: string;
  observedAt: number;
  capturedAt?: number;
  body?: string;
  media?: MediaKind[];
  outbound?: string;
  attachments?: MediaReference[];
  availability?: Availability;
}

export function subredditName(input: string): string {
  let value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    const url = redditUrl(value);
    if (url.search || url.hash || !/^\/r\/[^/]+\/?$/i.test(url.pathname)) {
      throw new Error('Use a subreddit name or its Reddit community URL');
    }
    value = url.pathname;
  }
  value = value.replace(/^\/?r\//i, '').replace(/\/$/, '');
  if (!/^[a-z0-9_]{2,21}$/i.test(value)) throw new Error('Invalid subreddit name');
  return value.toLowerCase();
}

export function postId(input: string): string {
  const value = input.toLowerCase().replace(/^t3_/, '');
  if (!/^[a-z0-9]{1,16}$/.test(value)) throw new Error('Invalid Reddit post ID');
  return `t3_${value}`;
}

export function redditUrl(input: string): URL {
  const url = new URL(input, 'https://www.reddit.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['www.reddit.com', 'old.reddit.com', 'reddit.com'].includes(url.hostname)) {
    throw new Error('Expected an HTTPS Reddit URL');
  }
  return url;
}

export function canonicalPostUrl(input: string, id: string, subreddit: string): string {
  const url = redditUrl(input);
  const match = /^\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/[^/]*)?\/?$/i.exec(url.pathname);
  if (!match || subredditName(match[1]!) !== subredditName(subreddit) ||
      postId(match[2]!) !== postId(id)) throw new Error('Post URL does not match its identity');
  return `https://www.reddit.com/r/${subredditName(subreddit)}/comments/${postId(id).slice(3)}/`;
}

/** ISO DOM datetime only. Relative labels and timezone-less dates are deliberately rejected. */
export function absoluteTime(input: string): CreatedTime | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const parts = [year, month, day, hour, minute, second ?? '0'].map(Number);
  const [y, m, d, h, min, s] = parts;
  const local = new Date(0);
  local.setUTCFullYear(y!, m! - 1, d!);
  local.setUTCHours(h!, min!, s!, 0);
  if (local.getUTCFullYear() !== y || local.getUTCMonth() + 1 !== m ||
      local.getUTCDate() !== d || local.getUTCHours() !== h ||
      local.getUTCMinutes() !== min || local.getUTCSeconds() !== s) return null;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const hours = Number(zone!.slice(1, 3));
    const minutes = Number(zone!.slice(4, 6));
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
    offsetMinutes = (hours * 60 + minutes) * (zone![0] === '+' ? 1 : -1);
  }
  return {
    epochMs: local.getTime() + Number((fraction ?? '').padEnd(3, '0')) - offsetMinutes * 60_000,
    precisionMs: fraction ? 10 ** (3 - fraction.length) : second ? 1_000 : 60_000,
  };
}

export function validateObservation(input: PostObservation): PostObservation {
  const subreddit = subredditName(input.subreddit);
  const id = postId(input.id);
  const permalink = canonicalPostUrl(input.permalink, id, subreddit);
  if (!input.title.trim() || input.title.length > 20_000) throw new Error('Invalid post title');
  if (!Number.isSafeInteger(input.created.epochMs) || input.created.epochMs < 0 ||
      ![1, 10, 100, 1_000, 60_000].includes(input.created.precisionMs)) {
    throw new Error('Invalid absolute post time or precision');
  }
  for (const time of [input.observedAt, input.capturedAt]) {
    if (time !== undefined && (!Number.isSafeInteger(time) || time < 0)) throw new Error('Invalid observation time');
  }
  if (!['live', 'archive'].includes(input.source)) throw new Error('Invalid observation source');
  if (input.source === 'archive' && (!input.exportId || input.exportId.length > 200)) {
    throw new Error('Archive observations require a bounded export identity');
  }
  if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 1_000_000)) {
    throw new Error('Invalid post body');
  }
  if (input.media !== undefined && (!Array.isArray(input.media) ||
      input.media.some(kind => !MEDIA_KINDS.includes(kind)))) throw new Error('Invalid media category');
  if (input.availability && !['available', 'deleted', 'removed'].includes(input.availability)) {
    throw new Error('Invalid availability marker');
  }
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 20 ||
    input.attachments.some(item => !item || mediaReference(item.url)?.kind !== item.kind ||
      (item.audioUrl !== undefined && (item.kind!=='video'||mediaReference(item.audioUrl)?.kind!=='video'||new URL(item.audioUrl).hostname!=='v.redd.it'))))) throw new Error('Invalid media attachment');
  const marker = input.body?.trim();
  const availability = marker === '[deleted]' ? 'deleted' : marker === '[removed]' ? 'removed' : input.availability;
  let outbound:string|undefined;
  try{if(input.outbound&&input.outbound.length<=4000){const url=new URL(input.outbound,'https://www.reddit.com');if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)outbound=url.href;}}catch{/* Ignore invalid outbound evidence without losing the post. */}
  return { ...input, id, subreddit, permalink, availability, outbound, media: input.media ? [...new Set(input.media)] : undefined };
}
