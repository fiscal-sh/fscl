if (!('navigator' in globalThis)) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      platform: process.platform === 'win32' ? 'Win32' : process.platform,
    },
    configurable: true,
  });
}

await import('./main.js');
