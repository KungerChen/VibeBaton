import { expect, test } from 'vitest';
import { MESSAGES } from '../i18n/messages';
import { transferCards } from './sidebarTransfer';

test.each([
  { caseExportAvailable: true, kinds: ['import', 'export-recipe', 'export-case'] },
  { caseExportAvailable: false, kinds: ['import', 'export-recipe'] },
])(
  'lists the expected transfer cards (caseExportAvailable: $caseExportAvailable)',
  ({ caseExportAvailable, kinds }) => {
    const cards = transferCards(caseExportAvailable, MESSAGES.en.transfer);
    expect(cards.map(({ kind }) => kind)).toEqual(kinds);
    expect(cards).toHaveLength(caseExportAvailable ? 3 : 2);
  },
);

test('reads every card title and description from the transfer copy', () => {
  const copy = MESSAGES.en.transfer;
  expect(transferCards(true, copy)).toEqual([
    { kind: 'import', ...copy.importCard },
    { kind: 'export-recipe', ...copy.exportRecipeCard },
    { kind: 'export-case', ...copy.exportCaseCard },
  ]);
});

test('keeps the English Save, Import & Share copy ASCII and names both file formats', () => {
  const { sectionTitle, sectionSubtitle } = MESSAGES.en.transfer;
  const copy = [
    sectionTitle,
    sectionSubtitle,
    ...transferCards(true, MESSAGES.en.transfer).flatMap(({ title, desc }) => [title, desc]),
  ].join('\n');
  expect(copy).toMatch(/^[\x00-\x7f]+$/);
  expect(copy).not.toMatch(/[\u3400-\u9fff]/);
  expect(copy).toContain('.baton.json');
  expect(copy).toContain('.baton-case.json');
});
