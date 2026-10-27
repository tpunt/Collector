export type SearchScope='both'|'title'|'body';
/** Shared by indexed text and queries; no query-language interpretation. */
export const normalizeText=(text:string)=>text.normalize('NFC').toLowerCase();
