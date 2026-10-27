import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {mediaReference} from './media-reference.ts';
import type {MediaReference} from './media-reference.ts';

/** Only explicit MPD BaseURL files are supported. No guessed names, API calls,
 * external entities, remote XML references, encrypted media or segment synthesis. */
export function dashMedia(xml:string,manifest:string):MediaReference {
 if(Buffer.byteLength(xml)>512*1024||/<!DOCTYPE|<!ENTITY/i.test(xml)||XMLValidator.validate(xml)!==true)throw new Error('Invalid or oversized media manifest');
 const root=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false,processEntities:true}).parse(xml)?.MPD;
 if(!root)throw new Error('Expected a DASH media manifest');
 const list=(value:any):any[]=>value===undefined?[]:Array.isArray(value)?value:[value];
 const base=(node:any,parent:string)=>{const value=node?.BaseURL;if(value===undefined)return parent;const text=typeof value==='string'?value:value?.['#text'];if(typeof text!=='string')throw new Error('Unsupported media BaseURL');return new URL(text,parent).href;};
 const owner=new URL(manifest),prefix=`/${owner.pathname.split('/').filter(Boolean)[0]}/`;
 const videos:{url:string;height:number;bandwidth:number;avc:boolean}[]=[],audios:{url:string;bandwidth:number}[]=[];
 for(const period of list(root.Period))for(const adaptation of list(period.AdaptationSet)){
  if(adaptation.ContentProtection)continue;
  for(const representation of list(adaptation.Representation)){
   if(representation.ContentProtection||!representation.BaseURL)continue;
   const url=base(representation,base(adaptation,base(period,base(root,manifest)))),parsed=mediaReference(url);
   if(parsed?.kind!=='video'||!url.match(/\.mp4(?:\?|$)/i)||new URL(url).hostname!==owner.hostname||!new URL(url).pathname.startsWith(prefix))continue;
   const mime=String(representation['@_mimeType']??adaptation['@_mimeType']??''),codecs=String(representation['@_codecs']??adaptation['@_codecs']??'');
   const bandwidth=Number(representation['@_bandwidth']??0),height=Number(representation['@_height']??adaptation['@_height']??0);
   if(mime==='video/mp4')videos.push({url,height,bandwidth,avc:/avc[13]/.test(codecs)});
   else if(mime==='audio/mp4')audios.push({url,bandwidth});
  }
 }
 const compatible=videos.some(item=>item.avc)?videos.filter(item=>item.avc):videos;
 const bounded=compatible.filter(item=>item.height<=720),choices=bounded.length?bounded:compatible;
 choices.sort((a,b)=>bounded.length?b.height-a.height||b.bandwidth-a.bandwidth:a.height-b.height||a.bandwidth-b.bandwidth);
 const video=choices[0];if(!video)throw new Error('The manifest has no supported single-file video representation');
 const audioChoices=audios.filter(item=>item.bandwidth<=128000);(audioChoices.length?audioChoices:audios).sort((a,b)=>audioChoices.length?b.bandwidth-a.bandwidth:a.bandwidth-b.bandwidth);
 const audio=(audioChoices.length?audioChoices:audios)[0];
 return {kind:'video',url:video.url,...audio?{audioUrl:audio.url}:{}};
}
