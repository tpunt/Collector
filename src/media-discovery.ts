import type {Page} from 'playwright';
import {mediaReferences, postMediaReferences, isGallery} from './media-reference.ts';
import type {MediaReference} from './media-reference.ts';
import {postId} from './domain.ts';
import {setTimeout as delay} from 'node:timers/promises';
import { UnsupportedMediaError,PostUnavailableError,PostIdentityError } from './sync-errors.ts';
import {collectClassicThreadDom} from './extract.ts';
import {discoverGallery} from './gallery.ts';

/** Use the real expand control. Blob playback needs the player's observed CDN file requests;
 * those are suppressed by the gate and later downloaded through the shared paced queue.
 * Post text still comes exclusively from rendered DOM, never network bodies or hidden state. */
export async function discoverMedia(page: Page, expectedId: string, candidates:()=>string[], signal:AbortSignal):Promise<MediaReference[]> {
  const id=postId(expectedId),identity=await page.evaluate(collectClassicThreadDom,id);
  if(identity.postId!==id)throw new PostIdentityError(id,identity.visiblePostIds,page.url());
  if(identity.availability)throw new PostUnavailableError(identity.availability);
  const post=page.locator(`.thing[data-fullname="${id}"]:not(.side *, .gadget *, .commentarea *, .promoted, .promoted *):visible`);
  if(await post.count()!==1)throw new PostIdentityError(id,identity.visiblePostIds,page.url());
  const expand=post.locator('.expando-button.collapsed');
  if(await expand.count())await expand.first().click();
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    signal.throwIfAborted();
    const dom=await post.evaluate(el=>{
      const shown=(node:Element)=>{const style=getComputedStyle(node);return node.isConnected&&!node.closest('[hidden],[aria-hidden="true"],template')&&style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0;};
      return {outbound:el.getAttribute('data-url')??el.querySelector('a.title')?.getAttribute('href'),
        images:Array.from(el.querySelectorAll('.expando img,.media-preview img')).filter(shown).map(node=>node.getAttribute('src')),
        videos:Array.from(el.querySelectorAll('.expando video')).filter(shown).map(node=>node.getAttribute('src'))};
    });
    if(isGallery(dom.outbound))return discoverGallery(page,id,signal);
    const direct=postMediaReferences(dom.outbound,mediaReferences([dom.outbound,...dom.images,...dom.videos]));
    if(direct.length)return direct;
    let base:URL;try{base=new URL(dom.outbound??'');}catch{throw new Error('Media discovery found no download link; sync this feed again to retry');}
    if(base.hostname==='v.redd.it'){
      const prefix=`https://v.redd.it/${base.pathname.split('/').filter(Boolean)[0]}/`;
      const observed=mediaReferences(candidates().filter(url=>url.startsWith(prefix)));
      const manifest=observed.find(item=>/\.mpd(?:\?|$)/i.test(item.url));
      if(manifest)return [manifest];
    }else if(['reddit.com','www.reddit.com','old.reddit.com'].includes(base.hostname)){
      throw new Error('Media discovery found no download link; sync this feed again to retry');
    }else throw new UnsupportedMediaError('Offline download is not supported for this embedded provider');
    await delay(250,undefined,{signal});
  }
  // A player that did not finish loading is inconclusive, not permanent unavailability.
  throw new Error('The video player did not expose a download before the timeout; sync this feed again to retry');
}
