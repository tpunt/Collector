import { SyncLimitError } from './sync-errors.ts';

export const GB = 1_000_000_000;
export const DEFAULT_STORAGE_CAP = 10 * GB;
export const STORAGE_CAP_MESSAGE = 'Storage cap reached. Increase Max stored size in Settings, then Continue.';
export class StorageLimitError extends SyncLimitError {
  constructor() { super(STORAGE_CAP_MESSAGE); }
}
export function storageCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000_000 || value > 10_000 * GB) {
    throw new Error('Choose a storage cap between 0.001 and 10,000 GB');
  }
  return value;
}
export interface StorageStatus { usedBytes:number; limitBytes:number; percentUsed:number; full:boolean }
