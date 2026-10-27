export class SyncLimitError extends Error {}
export class UnsupportedMediaError extends Error {}

export class PostUnavailableError extends Error {
  readonly availability:'removed'|'deleted';
  constructor(availability:'removed'|'deleted') {
    super(`Reddit marks this post ${availability}; media skipped`);
    this.name='PostUnavailableError';this.availability=availability;
  }
}

export class PostIdentityError extends Error {
  readonly expectedId:string;
  readonly visibleMainIds:string[];
  readonly pageUrl:string;
  constructor(expectedId:string,visibleIds:(string|null)[],pageUrl:string) {
    const ids=visibleIds.filter((id):id is string=>id!==null).slice(0,5);
    let location='unknown';
    try{const url=new URL(pageUrl);location=url.origin==='null'?url.protocol+url.pathname:url.origin+url.pathname;}catch{/* No query strings or credentials in diagnostics. */}
    super(`Thread layout could not identify requested post ${expectedId}; visible main post IDs: ${ids.join(', ')||'none'}. Page: ${location}`);
    this.name='PostIdentityError';this.expectedId=expectedId;this.visibleMainIds=ids;this.pageUrl=location;
  }
}
