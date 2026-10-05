import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { embeddedFontCss, fontLicenseNotices } from '../src/report/embedded-fonts.js';

it('committed font module preserves each vendored font and full license notice', async () => {
  const assets = ['SourceSerif4-variable-latin.woff2', 'IBMPlexSansCondensed-400-latin.woff2', 'IBMPlexSansCondensed-600-latin.woff2', 'JetBrainsMono-400-latin.woff2'];
  const fonts = [...embeddedFontCss.matchAll(/base64,([A-Za-z0-9+/=]+)\)/g)].map(m => Buffer.from(m[1]!, 'base64'));
  expect(fonts).toHaveLength(assets.length);
  for (const [i, asset] of assets.entries()) expect(fonts[i]).toEqual(await readFile(new URL(`../src/report/fonts/${asset}`, import.meta.url)));
  const licenses = ['OFL-SourceSerif4.txt', 'OFL-IBMPlex.txt', 'OFL-JetBrainsMono.txt'];
  expect(fontLicenseNotices).toHaveLength(licenses.length);
  for (const [i, license] of licenses.entries()) expect(fontLicenseNotices[i]).toBe(await readFile(new URL(`../src/report/fonts/${license}`, import.meta.url), 'utf8'));
});
