import type { Messages } from '../i18n/messages';
import type { TransferModalKind } from './RecipeTransferModals';

export type TransferCardKind = Exclude<TransferModalKind, null>;

export interface TransferCard {
  kind: TransferCardKind;
  title: string;
  desc: string;
}

export function transferCards(
  caseExportAvailable: boolean,
  t: Messages['transfer'],
): TransferCard[] {
  const cards: TransferCard[] = [
    { kind: 'import', ...t.importCard },
    { kind: 'export-recipe', ...t.exportRecipeCard },
  ];
  if (caseExportAvailable) {
    cards.push({ kind: 'export-case', ...t.exportCaseCard });
  }
  return cards;
}
