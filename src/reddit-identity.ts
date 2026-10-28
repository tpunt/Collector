/** Reddit-specific community names and allowed website origins. */
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

export function redditUrl(input: string): URL {
  const url = new URL(input, 'https://www.reddit.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['www.reddit.com', 'old.reddit.com', 'reddit.com'].includes(url.hostname)) {
    throw new Error('Expected an HTTPS Reddit URL');
  }
  return url;
}

