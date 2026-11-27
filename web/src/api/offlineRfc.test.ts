import { expect, test } from 'vitest';
import type { RfcReadinessResult } from '../types/graph';
import { checkRfcReadiness } from './offlineRfc';

const goalText = 'Build a deterministic readiness scorer that never performs file or network I/O.';
const constraintsText = 'Use only the existing runtime.';
const nonGoalsText = 'Do not call the network.';
const command = 'python -m unittest discover';

function rfc({
  goal = goalText,
  constraints = constraintsText,
  nonGoals = nonGoalsText,
  acceptance = `1. Running \`${command}\` exits successfully.`,
}: { goal?: string; constraints?: string; nonGoals?: string; acceptance?: string } = {}): string {
  return [
    '# RFC', '',
    '## Goal', '', goal, '',
    '## Constraints', '', constraints, '',
    '## Non-goals', '', nonGoals, '',
    '## Acceptance Criteria', '', acceptance, '',
  ].join('\n');
}

const completeReadiness: RfcReadinessResult = {
  score: 100,
  safe_for_overnight: true,
  missing_sections: [],
  warnings: [],
  detected_commands: ['python -m unittest'],
};
const emptyReadiness: RfcReadinessResult = {
  score: 0,
  safe_for_overnight: false,
  missing_sections: ['goal', 'constraints', 'acceptance'],
  warnings: [],
  detected_commands: [],
};

// Shared cases from tests/test_rfc_checker.py, with full response assertions.
test.each([
  { name: 'empty', markdown: '', expected: emptyReadiness },
  { name: 'whitespace', markdown: '  \n\t\n', expected: emptyReadiness },
  { name: 'complete with python -m unittest', markdown: rfc(), expected: completeReadiness },
  {
    name: 'missing acceptance even with a verification command elsewhere',
    markdown: `# RFC\n## Goal\n${goalText}\n## Constraints\nRun \`${command}\` before delivery.`,
    expected: { ...completeReadiness, score: 75, missing_sections: ['acceptance'], safe_for_overnight: false },
  },
  {
    name: 'complete sections without a verification command',
    markdown: rfc({ acceptance: '1. The scorer emits a readiness score.' }),
    expected: { ...completeReadiness, score: 80, detected_commands: [], safe_for_overnight: false },
  },
])('scores a $name RFC like Python', ({ markdown, expected }) => {
  expect(checkRfcReadiness(markdown)).toEqual(expected);
});

test.each([
  [rfc({ goal: `${goalText} tbd TBD` }), "Ambiguity marker 'TBD' found."],
  [rfc({ constraints: 'TODO: preserve the existing runtime.' }), "Ambiguity marker 'TODO' found."],
  [rfc({ constraints: 'Preserve the runtime, etc.' }), "Ambiguity marker 'etc.' found."],
  [rfc({ constraints: 'Maybe preserve the runtime.' }), "Ambiguity marker 'maybe' found."],
  [rfc().replace('## Acceptance Criteria', '## Acceptance Criteria?'), 'Question mark found in a heading.'],
  [rfc({ goal: 'Ship it.' }), 'Goal is shorter than 40 characters.'],
  [rfc({ acceptance: 'python -m unittest' }), 'Acceptance criteria are not numbered.'],
])('deducts five points for one warning %#', (markdown, warning) => {
  expect(checkRfcReadiness(markdown)).toEqual({ ...completeReadiness, score: 95, warnings: [warning] });
});

test('floors penalties at zero and applies the inclusive overnight threshold', () => {
  const warnings = [
    "Ambiguity marker 'TBD' found.", "Ambiguity marker 'TODO' found.",
    "Ambiguity marker 'etc.' found.", "Ambiguity marker 'maybe' found.",
  ];
  expect(checkRfcReadiness('TBD TODO etc. maybe')).toEqual({ ...emptyReadiness, warnings });

  const draft = rfc({ goal: 'Maybe', constraints: 'TODO TBD etc.\n### Open question?', acceptance: command });
  const belowThreshold = checkRfcReadiness(draft);
  expect(belowThreshold).toEqual({
    ...completeReadiness,
    score: 65,
    safe_for_overnight: false,
    warnings: [
      ...warnings, 'Question mark found in a heading.', 'Goal is shorter than 40 characters.',
      'Acceptance criteria are not numbered.',
    ],
  });
  expect(checkRfcReadiness(draft.replace(command, `1. ${command}`))).toEqual({
    ...completeReadiness, score: 70, warnings: belowThreshold.warnings.slice(0, -1),
  });
});

test.each([
  ['python3.11 -m unittest discover', ['python -m unittest']],
  ['unittest discover', ['unittest']],
  ['pytest -q && pytest -q', ['pytest']],
  ['vitest run', ['vitest']],
  ['npm test', ['npm test']],
  ['npm t', ['npm test']],
  ['npm run lint', ['npm run']],
  ['npm --workspace web test', ['npm test']],
  ['npm --workspace=web test', ['npm test']],
  ['npm -w web test', ['npm test']],
  ['npm --workspace web run test', ['npm test']],
  ['npx vitest run', ['npx', 'vitest']],
  ['cargo test --all', ['cargo test']],
  ['go test ./...', ['go test']],
  ['make test', ['make test']],
  ['./mvnw verify', ['mvn']],
  ['./gradlew test', ['gradle']],
  ['dotnet test', ['dotnet test']],
])('detects and normalizes %s', (verificationCommand, detected_commands) => {
  const markdown = rfc({ acceptance: `1. Run \`${verificationCommand}\`.` });
  expect(checkRfcReadiness(markdown)).toEqual({ ...completeReadiness, detected_commands });
});

test.each([
  ['mixed-case bold headings', [
    `**OBJECTIVE:** ${goalText} Does it stay entirely offline?`,
    '**Out-of-scope:** Network calls.',
    '**验收:**',
    `1. ${command} passes.`,
  ]],
  ['numbered headings', [
    '## 1. Goal', goalText,
    '## 2. Hard Constraints & Invariants', constraintsText,
    '## 3. Verification', `1. ${command} passes.`,
  ]],
])('recognizes %s', (_, lines) => {
  expect(checkRfcReadiness(['# RFC', ...lines].join('\r\n'))).toEqual(completeReadiness);
});

test('recognizes Chinese headings and applies the short-goal warning', () => {
  const markdown = [
    '## 目标说明',
    '构建一个完全离线的确定性 RFC 就绪评分器，并提供完整的测试与验证命令。',
    '## 约束条件', '保留现有功能。',
    '## 验收标准', `1. ${command} 通过。`,
  ].join('\r\n');
  expect(checkRfcReadiness(markdown)).toEqual({
    ...completeReadiness, score: 95, warnings: ['Goal is shorter than 40 characters.'],
  });
});

test('recognizes a command in constraints and respects Unicode word boundaries', () => {
  const markdown = rfc({
    constraints: 'Run pytest -q from the workspace root.',
    acceptance: '1. Verification exits successfully.',
  });
  expect(checkRfcReadiness(markdown)).toEqual({ ...completeReadiness, detected_commands: ['pytest'] });
  expect(checkRfcReadiness('运行pytest并在完成后提交')).toEqual(emptyReadiness);
});

test.each(['', 'json', 'jsonc'])('skips JSON output in a "%s" code fence', (language) => {
  const markdown = rfc({ acceptance: `1. Check the output.\n\n\`\`\`${language}\n{"runner":"pytest"}\n\`\`\`` });
  expect(checkRfcReadiness(markdown)).toEqual({
    ...completeReadiness, score: 80, safe_for_overnight: false, detected_commands: [],
  });
});

test('treats Python JSON with non-finite values as output in a plain fence', () => {
  const output = '{"runner":"pytest","timings":[NaN,Infinity,-Infinity]}';
  const markdown = rfc({ acceptance: `1. Check the output.\n\n\`\`\`\n${output}\n\`\`\`` });
  expect(checkRfcReadiness(markdown)).toEqual({
    ...completeReadiness, score: 80, safe_for_overnight: false, detected_commands: [],
  });
});

test('keeps shorter fences and their headings inside an outer code block', () => {
  const wrapped = `\`\`\`\`markdown\n\`\`\`markdown\n${rfc()}\`\`\`\n\`\`\`\``;
  expect(checkRfcReadiness(wrapped)).toEqual({
    ...emptyReadiness, score: 20, detected_commands: ['python -m unittest'],
  });

  const acceptance = [
    '````markdown', '```', '## Constraints', `1. ${command}`, '```', '````', '1. Run the command shown above.',
  ].join('\n');
  expect(checkRfcReadiness(rfc({ acceptance }))).toEqual(completeReadiness);
});

test('ignores numbered lines inside fenced code when scoring acceptance', () => {
  expect(checkRfcReadiness(rfc({ acceptance: `\`\`\`text\n1. ${command}\n\`\`\`` }))).toEqual({
    ...completeReadiness, score: 95, warnings: ['Acceptance criteria are not numbered.'],
  });
});
