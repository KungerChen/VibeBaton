import { expect, test, vi } from 'vitest';
import { flagship_4tier } from './flagship_4tier';

test('flagship_4tier matches the repository preset', async () => {
  // The frontend dependencies omit @types/node, so type only the Node APIs used here.
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: 'utf8'): string;
  }>('node:fs');
  const { posix } = await vi.importActual<{
    posix: { join(...parts: string[]): string };
  }>('node:path');

  const path = posix.join('../../../../presets', 'flagship_4tier.baton.json');
  const json: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

  expect(flagship_4tier).toEqual(json);
});
