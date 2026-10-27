/** Identities are scoped to their platform; display names are not identity keys. */
export interface Author { platform:string; id:string; name:string }
export function authorIdentity(value:unknown):Author {
  const author=value as Author;
  if(!author||typeof author.platform!=='string'||!/^[a-z][a-z0-9._-]{0,49}$/.test(author.platform)||
    typeof author.id!=='string'||!author.id.trim()||author.id.length>200||/[\u0000-\u001f\u007f]/.test(author.id)||
    typeof author.name!=='string'||!author.name.trim()||author.name.length>200||/[\u0000-\u001f\u007f]/.test(author.name))throw new Error('Invalid author identity');
  return {platform:author.platform,id:author.id,name:author.name};
}
export const authorKey=(author:Author)=>JSON.stringify([author.platform,author.id]);
export const authorLabel=(author:Author)=>author.platform==='reddit'?'u/'+author.name:author.name;
