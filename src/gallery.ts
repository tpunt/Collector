import type {Page} from 'playwright';
import {postId} from './domain.ts';
import {mediaReference,MAX_MEDIA_REFERENCES} from './media-reference.ts';
import type {MediaReference} from './media-reference.ts';
import {setTimeout as delay} from 'node:timers/promises';

/** Read only the active slide. Hidden slide markup is not file evidence. */
export function collectGalleryDom(expectedId:string){
  const shown=(node:Element)=>{const s=getComputedStyle(node);return node.isConnected&&!node.closest('[hidden],[inert],[aria-hidden="true"],template')&&s.display!=='none'&&s.visibility!=='hidden'&&node.getClientRects().length>0;};
  const posts=[...document.querySelectorAll('.thing[data-fullname]')].filter(node=>node.getAttribute('data-fullname')===expectedId&&shown(node)&&!node.closest('.side,.gadget,.commentarea,.promoted'));
  if(posts.length!==1)return null;
  const post=posts[0]!,root=[...post.querySelectorAll('.media-preview[data-media-ids],.media-gallery[data-media-ids]')].find(shown);
  if(!root)return null;
  const ids=(root.getAttribute('data-media-ids')??'').split(',').filter(Boolean),panels=[...root.querySelectorAll('.gallery-preview')],active=panels.filter(shown);
  const panel=active.length===1?active[0]:null,next=panel?[...panel.querySelectorAll('.gallery-nav-next')].find(shown):null;
  const media=panel?[...panel.querySelectorAll('.media-preview-content img,.media-preview-content video')].filter(shown):[];
  const files=media.flatMap(node=>{const original=node.closest('a')?.getAttribute('href');return original?[original]:[node.getAttribute('src'),node.tagName==='VIDEO'?node.querySelector('source')?.getAttribute('src'):null];}).filter((url):url is string=>Boolean(url));
  const text:string[]=[];
  if(panel){const walker=document.createTreeWalker(panel,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode()))if(node.parentElement&&shown(node.parentElement)&&!node.parentElement.closest('.gallery-nav-bar')&&node.textContent?.trim())text.push(node.textContent.trim());}
  return {ids,panels:panels.length,index:panel?panels.indexOf(panel):-1,panelId:panel?.id,files,caption:text.join(' '),grid:!panel&&Boolean([...root.querySelectorAll('.gallery-tile')].find(shown)),next:next?!(next.classList.contains('gallery-nav-disabled')||next.hasAttribute('disabled')||next.getAttribute('aria-disabled')==='true'):null};
}

export async function discoverGallery(page:Page,input:string,signal:AbortSignal):Promise<MediaReference[]>{
  const id=postId(input),selector=`.thing[data-fullname="${id}"]:not(.side *, .gadget *, .commentarea *, .promoted *)`;
  let dom=await page.evaluate(collectGalleryDom,id);
  if(dom?.grid){await page.locator(selector+' .gallery-tile:visible').first().click();}
  const items:MediaReference[]=[];let expected:string[]|null=null;
  for(let index=0;index<MAX_MEDIA_REFERENCES;index++){
    const deadline=Date.now()+10_000;
    while(true){
      signal.throwIfAborted();dom=await page.evaluate(collectGalleryDom,id);
      if(dom&&dom.index===index&&dom.files.length)break;
      if(Date.now()>=deadline)throw new Error('Gallery slide did not finish loading; Resume to retry');
      await delay(100,undefined,{signal});
    }
    if(!expected)expected=dom.ids;
    if(!expected.length||expected.length>MAX_MEDIA_REFERENCES||dom.panels!==expected.length||JSON.stringify(dom.ids)!==JSON.stringify(expected)||dom.panelId!==`gallery-preview-${id.slice(3)}-${expected[index]}`)throw new Error('Gallery item count or slide identity changed or could not be verified; Resume to retry');
    const reference=dom.files.map(url=>mediaReference(new URL(url,page.url()).href)).find((ref):ref is MediaReference=>Boolean(ref));
    if(!reference)throw new Error('Gallery slide did not expose a supported file; Resume to retry');
    if(dom.caption.length>20_000)throw new Error('Gallery caption exceeds its validation bound; collection remains incomplete');
    items.push({...reference,...dom.caption?{caption:dom.caption}:{},collection:{id:'reddit:'+id,index,total:expected.length}});
    if(index===expected.length-1){if(dom.next===true)throw new Error('Gallery has more slides than its reported count; Resume to retry');return items;}
    if(dom.next!==true)throw new Error('Gallery ended before all its slides were collected; Resume to retry');
    await page.locator(selector+' .gallery-preview:visible .gallery-nav-next:visible').click();
  }
  throw new Error('Gallery exceeds the validated collection bound; collection remains incomplete');
}
