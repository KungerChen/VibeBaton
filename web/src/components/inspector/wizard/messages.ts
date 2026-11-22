import type { Locale, Messages } from '../../../i18n/messages';

// Copy specific to this wizard supplements the shared wizard and credential messages.
export const LAUNCH_MESSAGES = {
  en: {
    back: 'Back',
    next: 'Next',
    preflightPreset: 'Preflight Preset',
    noRequiredProviders: 'This preset lists no required providers.',
    noReadyPresets: 'No preset is ready on this host.',
    checkingProviders: 'Checking providers…',
    presetError: 'Could not refresh preset readiness.',
    retry: 'Retry',
    copied: 'Copied',
    copyError: 'Select the command to copy it.',
    apiKeys: 'Local API Key Setup',
    credentialsLoading: 'Loading credential status…',
    credentialsError: 'Could not load credential status.',
    credentialsSaving: 'Saving keys…',
    credentialsSaved: 'Keys saved.',
    credentialsSaveError: 'Could not save the keys.',
    generating: 'Generating RFC…',
    generateError: 'Could not generate the RFC. Try again.',
    checkingRfc: 'Checking RFC…',
    checkError: 'Could not check the RFC. Try again.',
    safeForOvernight: 'Ready for overnight',
    unsafeForOvernight: 'Needs review for overnight',
    acceptance: 'Acceptance Criteria',
    startError: 'Could not start the run.',
  },
  zh: {
    back: '上一步',
    next: '下一步',
    preflightPreset: '预检预设',
    noRequiredProviders: '此预设未列出所需提供方。',
    noReadyPresets: '本机暂无已就绪的预设。',
    checkingProviders: '正在检查提供方…',
    presetError: '无法刷新预设就绪状态。',
    retry: '重试',
    copied: '已复制',
    copyError: '请选择命令并手动复制。',
    apiKeys: '本地 API 密钥设置',
    credentialsLoading: '正在加载凭据状态…',
    credentialsError: '无法加载凭据状态。',
    credentialsSaving: '正在保存密钥…',
    credentialsSaved: '密钥已保存。',
    credentialsSaveError: '无法保存密钥。',
    generating: '正在生成 RFC…',
    generateError: '无法生成 RFC，请重试。',
    checkingRfc: '正在检查 RFC…',
    checkError: '无法检查 RFC，请重试。',
    safeForOvernight: '可通宵运行',
    unsafeForOvernight: '通宵运行前需审查',
    acceptance: '验收标准',
    startError: '无法启动运行。',
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
