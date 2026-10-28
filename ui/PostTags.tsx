import React,{useState} from 'react';
import type {StoredPost} from '../src/store.ts';

export function PostTags({post,select,edit}:{post:StoredPost;select:(tag:string)=>void;edit:()=>void}){
  return <div className="post-tags" aria-label={'Tags: '+post.title}>{post.tags.map(tag=><button className="tag-pill" key={tag} onClick={()=>select(tag)}>{tag}</button>)}<button className="tag-edit" aria-label={'Edit tags: '+post.title} onClick={edit}>{post.tags.length?'Edit tags':'+ Tag'}</button></div>;
}
export function TagEditor({post,available,busy,save}:{post:StoredPost;available:{name:string}[];busy:boolean;save:(tags:string[])=>Promise<boolean>}){
  const [tags,setTags]=useState(post.tags),[value,setValue]=useState(''),[error,setError]=useState('');
  function add(){const tag=value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();if(!tag||tag.length>60){setError('Enter a tag with 1–60 characters');return;}if(tags.length>=50&&!tags.includes(tag)){setError('Use at most 50 tags per post');return;}setTags(old=>[...new Set([...old,tag])].sort());setValue('');setError('');}
  function submit(){const next=value.trim()?[...new Set([...tags,value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()])].sort():tags;if(next.length>50){setError('Use at most 50 tags per post');return;}void save(next);}
  return <form onSubmit={event=>{event.preventDefault();submit();}}>
    <p className="muted">Local tags work with search, favourites and media filters.</p>
    <div className="tag-editor-list">{tags.map(tag=><button type="button" key={tag} className="tag-pill" disabled={busy} aria-label={'Remove tag: '+tag} onClick={()=>setTags(old=>old.filter(item=>item!==tag))}>{tag} ×</button>)}</div>
    <label>Tag<input autoFocus maxLength={60} list="saved-tags" value={value} disabled={busy} onChange={event=>setValue(event.target.value)} placeholder="e.g. inspiration"/></label><datalist id="saved-tags">{available.map(tag=><option key={tag.name} value={tag.name}/>)}</datalist>
    <div className="dialog-actions"><button className="button" type="button" disabled={busy||!value.trim()} onClick={add}>Add tag</button><button className="button primary" disabled={busy} type="button" onClick={submit}>Save tags</button></div>{error&&<p role="alert">{error}</p>}
  </form>;
}
