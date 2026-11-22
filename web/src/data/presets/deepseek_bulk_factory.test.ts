import { expect, test, vi } from 'vitest';
import { deepseek_bulk_factory } from './deepseek_bulk_factory';

test('deepseek_bulk_factory matches the repository preset', async () => {
  // The frontend dependencies omit @types/node, so type only the Node APIs used here.
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: 'utf8'): string;
  }>('node:fs');
  const { posix } = await vi.importActual<{
    posix: { join(...parts: string[]): string };
  }>('node:path');

  const path = posix.join('../../../../presets', 'deepseek_bulk_factory.baton.json');
  const json: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

  expect(deepseek_bulk_factory).toEqual(json);
});
