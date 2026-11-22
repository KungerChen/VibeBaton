import { expect, test, vi } from 'vitest';
import { codex_only_3tier } from './codex_only_3tier';

test('codex_only_3tier matches the repository preset', async () => {
  // The frontend dependencies omit @types/node, so type only the Node APIs used here.
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: 'utf8'): string;
  }>('node:fs');
  const { posix } = await vi.importActual<{
    posix: { join(...parts: string[]): string };
  }>('node:path');

  const path = posix.join('../../../../presets', 'codex_only_3tier.baton.json');
  const json: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

  expect(codex_only_3tier).toEqual(json);
});
