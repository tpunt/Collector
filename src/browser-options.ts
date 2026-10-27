/** Shared by the probe and local browser checks. Keep Chrome's security sandbox enabled. */
export const browserLaunchOptions = {
  chromiumSandbox: true,
  serviceWorkers: 'block' as const,
  args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
};
