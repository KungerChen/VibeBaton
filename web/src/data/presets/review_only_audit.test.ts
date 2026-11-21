import { expect, test, vi } from 'vitest';
import { review_only_audit } from './review_only_audit';

test('review_only_audit matches the repository preset', async () => {
  // The frontend dependencies omit @types/node, so type only the Node APIs used here.
  const { readFileSync } = await vi.importActual<{
    readFileSync(path: URL, encoding: 'utf8'): string;
  }>('node:fs');
  const { posix } = await vi.importActual<{
    posix: { join(...parts: string[]): string };
  }>('node:path');

  const path = posix.join('../../../../presets', 'review_only_audit.baton.json');
  const json: unknown = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

  expect(review_only_audit).toEqual(json);
});
