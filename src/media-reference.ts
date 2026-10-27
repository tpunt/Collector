import {onlineEmbed} from './online-embed.ts';

export interface MediaReference { kind: 'image' | 'video'; url: string; audioUrl?: string; caption?:string; collection?:{id:string;index:number;total:number} }
export const MAX_MEDIA_REFERENCES=1000;

export function isGallery(input: string | null | undefined): boolean {
  try { const url = new URL(input ?? ''); return ['reddit.com','www.reddit.com','old.reddit.com'].includes(url.hostname) && /^\/gallery\//.test(url.pathname); }
  catch { return false; }
}

/** A preview list never establishes that an entire ordered collection was read. */
export function completeCollection(id:string,items:MediaReference[]):boolean {
  return items.length>0&&items.every((item,index)=>item.collection?.id===id&&item.collection.index===index&&item.collection.total===items.length);
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
  const items=[...new Map(inputs.map(input => input ? mediaReference(input) : null).filter((item): item is MediaReference => item !== null)
    .map(item => [item.url, item])).values()];
  if(items.length>MAX_MEDIA_REFERENCES)throw new Error('Too many media files to validate in one post; collection is incomplete');
  return items;
}

/** A native video's poster/preview is not the video. Require its canonical file
 * or an observed manifest belonging to the same video before counting it offline. */
export function postMediaReferences(outbound:string|null|undefined,references:MediaReference[]):MediaReference[] {
  // A saved preview image is not a downloaded external video.
  if(onlineEmbed(outbound))return references.filter(reference=>reference.kind==='video');
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

/** A provider's explicit deletion image cannot establish an offline copy. */
export function isRemovedMediaPlaceholder(input:string):boolean {
  try{const url=new URL(input);return url.hostname==='i.imgur.com'&&url.pathname.toLowerCase()==='/removed.png';}catch{return false;}
}
