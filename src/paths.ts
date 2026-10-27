import { join, resolve } from 'node:path';

// Anchor the default to this checkout, independently of the launch directory.
export const dataDirectory = resolve(process.env.REDDIT_READER_DATA_DIR ?? join(import.meta.dirname, '..', '.local-data'));
export const profileDirectory = join(dataDirectory, 'browser-profile');
export const databasePath = join(dataDirectory, 'reader.sqlite');
