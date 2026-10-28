import React,{createContext,useContext,useRef} from 'react';
export interface MediaSlide {id:string;kind:'image'|'video';url:string;title:string;caption?:string}
const Context=createContext<{register:(scope:string,post:string,slides:MediaSlide[])=>()=>void;slides:(scope:string)=>MediaSlide[]}|null>(null);
/** Registry contains local ready files only; opening a viewer never collects. */
export function MediaBrowsingProvider({order,children}:{order:string[];children:React.ReactNode}){
  const entries=useRef(new Map<string,{scope:string;post:string;slides:MediaSlide[]}>()),currentOrder=useRef(order);currentOrder.current=order;
  const [api]=React.useState(()=>({
    register(scope:string,post:string,slides:MediaSlide[]){const key=scope+':'+post,value={scope,post,slides};entries.current.set(key,value);return()=>{if(entries.current.get(key)===value)entries.current.delete(key);};},
    slides(scope:string){return[...entries.current.values()].filter(entry=>entry.scope===scope&&(scope!=='feed'||currentOrder.current.includes(entry.post))).sort((a,b)=>currentOrder.current.indexOf(a.post)-currentOrder.current.indexOf(b.post)).flatMap(entry=>entry.slides);}
  }));
  return <Context.Provider value={api}>{children}</Context.Provider>;
}
export const useMediaBrowsing=()=>useContext(Context);
