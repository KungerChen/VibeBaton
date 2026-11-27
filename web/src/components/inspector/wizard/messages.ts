import type { Locale, Messages } from '../../../i18n/messages';

// Copy specific to the RFC check supplements the shared wizard messages.
export const LAUNCH_MESSAGES = {
  en: {
    checkingRfc: 'Checking RFC…',
    checkError: 'Could not check the RFC. Try again.',
    safeForOvernight: 'Ready for overnight',
    unsafeForOvernight: 'Needs review for overnight',
    acceptance: 'Acceptance Criteria',
  },
  zh: {
    checkingRfc: '正在检查 RFC…',
    checkError: '无法检查 RFC，请重试。',
    safeForOvernight: '可通宵运行',
    unsafeForOvernight: '通宵运行前需审查',
    acceptance: '验收标准',
  },
} satisfies Record<Locale, Record<string, string>>;

export function translateRfcSection(section: string, locale: Locale, wizard: Messages['wizard']): string {
  switch (section) {
    case 'goal': return wizard.fields.goal;
    case 'constraints': return wizard.fields.constraints;
    case 'acceptance': return LAUNCH_MESSAGES[locale].acceptance;
    default: return section;
  }
}

export function translateRfcWarning(warning: string, messages: Messages['wizard']['warnings']): string {
  const marker = /^Ambiguity marker '(.+)' found\.$/.exec(warning);
  if (marker) return messages.ambiguityMarker(marker[1]);
  switch (warning) {
    case 'Question mark found in a heading.': return messages.questionInHeading;
    case 'Goal is shorter than 40 characters.': return messages.shortGoal;
    case 'Acceptance criteria are not numbered.': return messages.unnumberedAcceptance;
    default: return warning;
  }
}
