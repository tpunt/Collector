import React,{useRef,useState} from 'react';
import type {BackupPreview} from '../src/library-backup.ts';

export function BackupSettings({token,changed,setBusy}:{token:string;changed:(replaced?:boolean)=>Promise<void>;setBusy:(busy:boolean)=>void}){
  const [passphrase,setPassphrase]=useState(''),[repeat,setRepeat]=useState(''),[restorePassword,setRestorePassword]=useState('');
  const [file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<BackupPreview|null>(null),[download,setDownload]=useState('');
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const controller=useRef<AbortController|null>(null);
  async function request(path:string,body:BodyInit,headers:Record<string,string>={}){
    const response=await fetch('/api/'+path,{method:'POST',headers:{'X-Reader-Token':token,...headers},body,signal:controller.current?.signal});
    const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
  }
  async function run(message:string,work:()=>Promise<void>){
    setWorking(true);setBusy(true);setError('');setMessage(message);controller.current=new AbortController();
    try{await work();}catch(error){setMessage('');setError((error as Error).name==='AbortError'?'Operation cancelled':(error as Error).message);}
    finally{setWorking(false);setBusy(false);controller.current=null;}
  }
  const json=(data:unknown)=>JSON.stringify(data),headers={'Content-Type':'application/json'};
  return <section className="backup-settings"><h3>Encrypted backup</h3>
    <p className="muted">Includes posts, discussions, saved media, preferences, exclusions and read states. Browser sign-in is excluded. Creating or restoring a backup pauses collection. Temporary disk space is needed for a database snapshot and encrypted download; restoring also stages the replacement library and a rollback database.</p>
    <form onSubmit={event=>{event.preventDefault();if(passphrase!==repeat){setError('Passphrases do not match');return;}void run('Creating encrypted backup…',async()=>{
      const value=await request('backup/create',json({passphrase}),headers);setDownload('/api/backup/download/'+value.id);setPassphrase('');setRepeat('');setMessage('Backup ready. Download link expires in 10 minutes.');await changed();
    });}}>
      <label>Backup passphrase<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={passphrase} onChange={e=>setPassphrase(e.target.value)} disabled={working}/></label>
      <label>Repeat passphrase<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={repeat} onChange={e=>setRepeat(e.target.value)} disabled={working}/></label>
      <button className="button" disabled={working}>Create encrypted backup</button>{download&&<a className="button" href={download} download>Download backup</a>}
    </form><h3>Restore backup</h3>
    <form onSubmit={event=>{event.preventDefault();if(!file)return;void run('Decrypting and validating backup…',async()=>{
      const value=await request('restore/prepare',file,{'X-Backup-Passphrase':encodeURIComponent(restorePassword)});setPreview(value);setRestorePassword('');setMessage('Backup validated. Review before replacing your library.');
    });}}>
      <label>Encrypted backup file<input type="file" accept=".age" disabled={working} onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null);}} required/></label>
      <label>Restore passphrase<input type="password" autoComplete="off" maxLength={1024} disabled={working} value={restorePassword} onChange={e=>setRestorePassword(e.target.value)} required/></label>
      <button className="button" disabled={working||!file}>Validate backup</button>
    </form>
    {preview&&<div className="backup-preview" role="group" aria-label="Confirm library replacement"><p>{preview.posts.toLocaleString()} posts · {preview.files.toLocaleString()} media files · {(preview.bytes/1_000_000).toFixed(1)} MB</p><p>This replaces your current library, preferences, read states and exclusions. Your browser profile and current storage cap stay in place. Collection remains paused. Validation expires after 10 minutes.</p>
      <button className="button" disabled={working} onClick={()=>void run('Discarding staged backup…',async()=>{await request('restore/discard',json({id:preview.id}),headers);setPreview(null);setMessage('Restore cancelled; current library kept.');})}>Keep current library</button>
      <button className="button danger" disabled={working} onClick={()=>void run('Restoring library…',async()=>{const result=await request('restore/commit',json({id:preview.id,confirm:true}),headers);setPreview(null);setMessage('Library restored. Sync explicitly when ready; the current browser account will be verified.'+(result.warning?' '+result.warning:''));await changed(true);})}>Replace library</button>
    </div>}
    {working&&!preview&&<button className="button stop" type="button" onClick={()=>controller.current?.abort()}>Cancel operation</button>}
    {message&&<p role="status" className="muted">{message}</p>}{error&&<p role="alert" className="notice error">{error}</p>}
  </section>;
}
