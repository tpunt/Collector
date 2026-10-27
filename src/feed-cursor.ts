/** Shared opaque feed boundary for both ordinary paging and retained windows. */
export function feedCursor(post:{createdMs:number;id:string}):string {
  const bytes=new TextEncoder().encode(JSON.stringify({time:post.createdMs,id:post.id}));
  return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
