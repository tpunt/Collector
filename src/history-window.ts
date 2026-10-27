export const HISTORY_OPTIONS = [
  {months:1,label:'1 month'}, {months:3,label:'3 months'}, {months:6,label:'6 months'},
  {months:12,label:'1 year'}, {months:24,label:'2 years'}, {months:36,label:'3 years'},
  {months:60,label:'5 years'}, {months:0,label:'All time'},
] as const;
export type HistoryMonths = typeof HISTORY_OPTIONS[number]['months'];
export function historyMonths(value: unknown): HistoryMonths {
  if (typeof value !== 'number' || !HISTORY_OPTIONS.some(option=>option.months===value)) throw new Error('Choose a supported history limit');
  return value as HistoryMonths;
}
export function historyRank(months: HistoryMonths): number { return months===0?Infinity:months; }
/** Calendar months in UTC, clamping month-end dates rather than rolling into the next month. */
export function historyLowerBound(months: HistoryMonths, upperMs: number): number | null {
  if(months===0)return null;
  if(!Number.isSafeInteger(upperMs)||upperMs<0)throw new Error('Invalid history reference time');
  const date=new Date(upperMs),day=date.getUTCDate();
  date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-months);
  const end=new Date(date.getTime());end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
  date.setUTCDate(Math.min(day,end.getUTCDate()));
  return Math.max(0,date.getTime());
}
