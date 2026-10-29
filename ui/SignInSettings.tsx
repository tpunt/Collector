import React from 'react';
import type {Platform} from '../src/sources.ts';
import type {SignInStatus} from '../src/sign-in.ts';

export function SignInSettings({platform,status,active,disabled,open,close}:{platform:Platform;status:SignInStatus|undefined;active:boolean;disabled:boolean;open:()=>void;close:()=>void}){
  const label=platform==='tumblr'?'Tumblr':'Reddit',state=status?.state??'unknown';
  const message=state==='signed-in'?`Signed in${status?.account?' as '+status.account:''}`:
    state==='checking'?'Checking saved session…':state==='waiting'?'Waiting for you to sign in…':
    state==='unverified'?'Browser closed · sign-in not confirmed':state==='error'?'Sign-in check failed · please recheck':'Session not checked this run';
  return <section className="settings-account" aria-label={label+' sign-in'}>
    <div className="sign-in-heading"><strong>{label}</strong><span className={'session-status '+(state==='signed-in'?'confirmed':'')} role="status">{message}</span></div>
    {status?.verifiedAt&&state==='signed-in'&&<small>Verified <time dateTime={new Date(status.verifiedAt).toISOString()}>{new Date(status.verifiedAt).toLocaleString()}</time></small>}
    <button className="button" disabled={disabled} onClick={active?close:open}>{active?`Close ${label} sign-in browser`:state==='unknown'?`Open ${label} sign-in browser`:`Recheck ${label} sign-in`}</button>
    {active&&<p className="muted">Sign in in Chrome. Collector confirms sign-in and closes the window automatically. Closing it early leaves the session unverified.</p>}
  </section>;
}
