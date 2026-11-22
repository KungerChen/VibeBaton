import { expect, test, vi } from 'vitest';
import { solo_coder_3tier } from './solo_coder_3tier';

test('solo_coder_3tier matches the repository preset', async () => {
  // The frontend dependencies omit @types/node, so type only the Node APIs used here.
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: 'utf8'): string;
  }>('node:fs');
  const { posix } = await vi.importActual<{
    posix: { join(...parts: string[]): string };
  }>('node:path');

  const path = posix.join('../../../../presets', 'solo_coder_3tier.baton.json');
  const json: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

  expect(solo_coder_3tier).toEqual(json);
});
