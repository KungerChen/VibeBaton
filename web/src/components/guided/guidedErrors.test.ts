import { expect, test } from 'vitest';
import { MESSAGES } from '../../i18n/messages';
import { localizeGuidedError } from './guidedErrors';

test('a request that got no answer in time is described in the reader language', () => {
  const timeout = new Error('Request timed out');
  expect(localizeGuidedError(timeout, 'en')).toBe(MESSAGES.en.guided.errors.requestTimedOut);
  expect(localizeGuidedError(timeout, 'zh')).toBe('请求超时，没有等到回应。');
  // Unfamiliar technical messages stay as they are for diagnosis.
  expect(localizeGuidedError(new Error('Request timed out while reading the body'), 'zh'))
    .toBe('Request timed out while reading the body');
});
