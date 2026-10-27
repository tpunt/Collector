export interface MediaReference { kind: 'image' | 'video'; url: string; audioUrl?: string }

export function isGallery(input: string | null | undefined): boolean {
  try { const url = new URL(input ?? ''); return ['reddit.com','www.reddit.com','old.reddit.com'].includes(url.hostname) && /^\/gallery\//.test(url.pathname); }
  catch { return false; }
}

/** Public media CDNs only. Never a user-supplied fetch proxy or arbitrary website. */
export function mediaReference(input: string): MediaReference | null {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || input.length > 4000) return null;
    const image = ['i.redd.it', 'preview.redd.it', 'external-preview.redd.it', 'i.imgur.com'].includes(url.hostname)
      && /\.(png|jpe?g|gif|webp|avif)$/i.test(url.pathname);
    const video = ['v.redd.it', 'i.imgur.com', 'preview.redd.it'].includes(url.hostname)
      && (/\.(mp4|webm)$/i.test(url.pathname) || (url.hostname==='v.redd.it'&&/\.mpd$/i.test(url.pathname)));
    return image || video ? {kind: video ? 'video' : 'image', url: url.href} : null;
  } catch { return null; }
}

export function mediaReferences(inputs: (string | null | undefined)[]): MediaReference[] {
  return [...new Map(inputs.map(input => input ? mediaReference(input) : null).filter((item): item is MediaReference => item !== null)
    .map(item => [item.url, item])).values()].slice(0, 20);
}

/** A native video's poster/preview is not the video. Require its canonical file
 * or an observed manifest belonging to the same video before counting it offline. */
export function postMediaReferences(outbound:string|null|undefined,references:MediaReference[]):MediaReference[] {
  let owner:URL;
  try{owner=new URL(outbound??'');}catch{return references;}
  if(owner.hostname!=='v.redd.it')return references;
  const id=owner.pathname.split('/').filter(Boolean)[0];
  if(!id)return [];
  return references.filter(reference=>{
    const url=new URL(reference.url);
    return reference.kind==='video'&&url.hostname===owner.hostname&&url.pathname.startsWith(`/${id}/`)
      &&(url.href===owner.href||/\.mpd$/i.test(url.pathname));
  });
}
