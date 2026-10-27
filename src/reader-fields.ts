// A live listing may omit text that an archive saved. Search and reading must
// share the same provenance and removal policy.
export const ARCHIVE_JOIN=`LEFT JOIN observations archived ON o.source='live' AND archived.rowid=(
  SELECT rowid FROM observations WHERE post_id=p.id AND source='archive' AND availability='available'
  ORDER BY observed_at DESC,source_key DESC LIMIT 1)`;
export const POST_BODY='coalesce(o.body,archived.body)';
export const SEARCH_TEXT_SELECT=`SELECT p.id,normalize_text(o.title),normalize_text(CASE WHEN coalesce(p.live_availability,o.availability)='available' THEN coalesce(${POST_BODY},'') ELSE '' END)
 FROM posts p JOIN observations o ON o.rowid=(SELECT rowid FROM observations WHERE post_id=p.id ORDER BY (source='live') DESC,observed_at DESC,source_key DESC LIMIT 1) ${ARCHIVE_JOIN}`;
