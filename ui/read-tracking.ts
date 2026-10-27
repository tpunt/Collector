import {useEffect} from 'react';

/** Visible coverage belongs to the displayed card, not a source's observation. */
export class VisibleCoverage {
  private size='';
  private range='';
  private since=0;
  private covered:[number,number][]=[];
  resetDwell(){this.range='';}
  sample(height:number,width:number,top:number,bottom:number,now:number,viewportHeight:number):boolean {
    const size=`${height}:${width}:${viewportHeight}`;
    if(size!==this.size){this.size=size;this.covered=[];this.range='';}
    if(height<=viewportHeight&&(top>1||bottom<height-1)){this.covered=[];this.resetDwell();return false;}
    const range=`${Math.round(top)}:${Math.round(bottom)}`;
    if(range!==this.range){this.range=range;this.since=now;return false;}
    if(now-this.since<1000)return false;
    const ranges=[...this.covered,[top,bottom] as [number,number]].sort((a,b)=>a[0]-b[0]);
    this.covered=[];
    for(const entry of ranges){const last=this.covered.at(-1);if(last&&entry[0]<=last[1]+1)last[1]=Math.max(last[1],entry[1]);else this.covered.push([...entry]);}
    return this.covered.length===1&&this.covered[0]![0]<=1&&this.covered[0]![1]>=height-1;
  }
}

/** Ignore lazy images outside ancestor scroll clips; a finished error is settled. */
function hasPendingVisibleImage(card:HTMLElement):boolean {
  return [...card.querySelectorAll('img')].some(image=>{
    if(image.complete||!image.getClientRects().length)return false;
    const rect=image.getBoundingClientRect();let left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
    for(let parent=image.parentElement;parent&&card.contains(parent);parent=parent.parentElement){
      const style=getComputedStyle(parent),clip=parent.getBoundingClientRect();
      if(style.overflowX!=='visible'){left=Math.max(left,clip.left+parent.clientLeft);right=Math.min(right,clip.left+parent.clientLeft+parent.clientWidth);}
      if(style.overflowY!=='visible'){top=Math.max(top,clip.top+parent.clientTop);bottom=Math.min(bottom,clip.top+parent.clientTop+parent.clientHeight);}
    }
    return right>=left&&bottom>=top;
  });
}

export function useReadTracking(enabled:boolean,onRead:(id:string)=>Promise<void>,suppressed:Set<string>){
  useEffect(()=>{
    const coverage=new Map<string,VisibleCoverage>(),pending=new Set<string>();
    const timer=setInterval(()=>{
      const eligible=enabled&&document.visibilityState==='visible';
      for(const card of document.querySelectorAll<HTMLElement>('.post-card[data-post-id]')){
        const id=card.dataset.postId!;let seen=coverage.get(id);if(!seen){seen=new VisibleCoverage();coverage.set(id,seen);}
        const rect=card.getBoundingClientRect(),top=Math.max(0,-rect.top),bottom=Math.min(rect.height,innerHeight-rect.top);
        if(bottom<=top){suppressed.delete(id);seen.resetDwell();continue;}
        if(!eligible||suppressed.has(id)||card.dataset.read==='true'||pending.has(id)||rect.left<0||rect.right>innerWidth||
          card.querySelector('[data-read-pending="true"]')||hasPendingVisibleImage(card)) {seen.resetDwell();continue;}
        // Inset hit tests past rounded borders, whose corner pixels belong to
        // the background even when the card itself is completely unobscured.
        const y1=Math.max(8,rect.top+8),y2=Math.min(innerHeight-8,rect.bottom-8);
        const points=[[rect.left+8,y1],[rect.right-8,y1],[rect.left+8,y2],[rect.right-8,y2],[(rect.left+rect.right)/2,(y1+y2)/2]];
        if(points.some(([x,y])=>!card.contains(document.elementFromPoint(x!,y!)))){seen.resetDwell();continue;}
        if(seen.sample(rect.height,rect.width,top,bottom,performance.now(),innerHeight)){
          pending.add(id);void onRead(id).catch(()=>{seen!.resetDwell();}).finally(()=>pending.delete(id));
        }
      }
    },100);
    return()=>clearInterval(timer);
  },[enabled,onRead,suppressed]);
}
