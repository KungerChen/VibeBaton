import { MESSAGES, type Locale } from '../../i18n/messages';
import type { BatonCaseBundle, CaseRedactionReport } from '../../types/graph';

const counters = [
  ['secrets', 'secrets_redacted'],
  ['paths', 'paths_anonymized'],
  ['emails', 'emails_redacted'],
  ['ips', 'ips_redacted'],
  ['diffs', 'raw_diff_stripped'],
  ['stacks', 'raw_stack_stripped'],
] as const;

export function caseFileName(bundle: BatonCaseBundle): string {
  const slug = bundle.title.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'run-case'}.baton-case.json`;
}

export function checklistRows(report: CaseRedactionReport, locale: Locale) {
  const copy = MESSAGES[locale].transfer.exportCaseModal;
  return {
    rows: counters.map(([key, field]) => ({ key, label: copy[key], count: report[field] })),
    verifiedClean: report.clean,
  };
}

export function serializeCase(bundle: BatonCaseBundle): string {
  // A shared export of the built-in tutorial is a regular replay.
  const exportedBundle = bundle.isOfficialTutorial ? { ...bundle, isOfficialTutorial: false } : bundle;
  return JSON.stringify(exportedBundle, null, 2);
}
