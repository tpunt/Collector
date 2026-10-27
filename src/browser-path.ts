import { resolve } from 'node:path';

// Keep the browser binary in an ignored, project-owned cache. This is separate from the login profile.
export const browserCache = resolve(import.meta.dirname, '../.cache/playwright');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserCache;
