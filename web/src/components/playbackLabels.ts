import type { Messages } from '../i18n/messages';

type PlaybackCopy = Pick<Messages, 'playback' | 'transfer'>;

export interface ReplayCaseRef {
  case_id: string;
  title: string;
}

/** DOM values for cases carry this prefix so they never collide with switcher actions. */
export const CASE_OPTION_PREFIX = 'case:';

export type SwitcherOption =
  | { kind: 'case'; value: string; label: string; caseId: string }
  | { kind: 'import'; value: 'import'; label: string }
  | { kind: 'reset'; value: 'reset'; label: string };

export function replayToggleLabel(
  { isCustomCaseActive, activeCaseTitle }: { isCustomCaseActive: boolean; activeCaseTitle: string },
  messages: PlaybackCopy,
): string {
  return isCustomCaseActive
    ? `▶ ${messages.transfer.playback.startPrefix}${activeCaseTitle}`
    : messages.playback.replayButton;
}

export function switcherOptions(
  savedCases: readonly ReplayCaseRef[],
  officialId: string,
  messages: PlaybackCopy,
): SwitcherOption[] {
  const copy = messages.transfer.playback;
  const options: SwitcherOption[] = [{
    kind: 'case',
    value: `${CASE_OPTION_PREFIX}${officialId}`,
    label: messages.playback.replayButton,
    caseId: officialId,
  }];

  for (const { case_id, title } of savedCases) {
    if (case_id === officialId) continue;
    options.push({
      kind: 'case',
      value: `${CASE_OPTION_PREFIX}${case_id}`,
      label: title,
      caseId: case_id,
    });
  }

  options.push(
    { kind: 'import', value: 'import', label: copy.importAnother },
    { kind: 'reset', value: 'reset', label: copy.resetTutorial },
  );
  return options;
}
