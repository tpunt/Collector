/** Local labels belong to the reader, independently of a platform's own tags. */
export function tagName(value:unknown):string {
  if(typeof value!=='string')throw new Error('Invalid tag');
  const tag=value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  if(!tag||tag.length>60||/[\u0000-\u001f\u007f]/.test(tag))throw new Error('Tags must contain 1–60 characters');
  return tag;
}
export function postTags(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>50)throw new Error('Use at most 50 tags per post');
  return [...new Set(value.map(tagName))].sort();
}
