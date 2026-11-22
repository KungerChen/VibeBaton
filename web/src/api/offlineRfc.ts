import type { RfcBrainstormRequest, RfcBrainstormResult, RfcReadinessResult } from '../types/graph';

// Keep the scoring, section aliases, and command families aligned with rfc_checker.py.
const SECTIONS = [
  { name: 'goal', weight: 30, pattern: /^(?:(?:goals?|objectives?)(?![\p{L}\p{N}_])|目标)/iu },
  {
    name: 'constraints',
    weight: 25,
    pattern: /^(?:(?:(?:hard )?constraints?|non[\s-]?goals?|out[\s-]?of[\s-]?scope)(?![\p{L}\p{N}_])|约束)/iu,
  },
  { name: 'acceptance', weight: 25, pattern: /^(?:(?:acceptance|verification|tests?|testing)(?![\p{L}\p{N}_])|验收)/iu },
] as const;

type Section = typeof SECTIONS[number]['name'];

interface Heading {
  label: string;
  section?: Section;
  body: string;
}

interface Fence {
  marker: string;
  length: number;
  language: string;
  lines: string[];
}

const HEADING = /^[ \t]{0,3}#{1,6}[ \t]*(\S.*?)[ \t]*$/;
const BOLD_HEADING = /^[ \t]{0,3}(?:[-*+][ \t]+)?(?:\*\*|__)([^*_\n]+?)(?:\*\*|__)(.*)$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const NUMBERED_ITEM = /^[ \t]*\p{Nd}+[.)][ \t]*\S/u;
const INLINE_SEPARATORS = /^[ \t:：—–-]+|[ \t:：—–-]+$/g;
const LINE_BREAK = /\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/;
const SHELL_LANGUAGES = new Set([
  'bash', 'bat', 'batch', 'cmd', 'console', 'fish', 'powershell', 'ps1', 'pwsh', 'sh', 'shell', 'zsh',
]);
const PLAIN_LANGUAGES = new Set(['', 'output', 'plaintext', 'text', 'txt']);

// Python's word boundaries include Unicode letters and numbers.
const WORD_START = String.raw`(?<![\p{L}\p{N}_])`;
const WORD_END = String.raw`(?![\p{L}\p{N}_])`;
const AMBIGUITY_MARKERS = [
  ['TBD', new RegExp(`${WORD_START}TBD${WORD_END}`, 'iu')],
  ['TODO', new RegExp(`${WORD_START}TODO${WORD_END}`, 'iu')],
  ['etc.', new RegExp(String.raw`${WORD_START}etc\.`, 'iu')],
  ['maybe', new RegExp(`${WORD_START}maybe${WORD_END}`, 'iu')],
] as const;

const NPM_OPTION = String.raw`--?[A-Za-z][\p{L}\p{N}_-]*(?:[ \t]*=[ \t]*[^\s-][^\s]*|[ \t]+[^\s-][^\s]*)?`;
const NPM_LEAD = String.raw`npm(?:[ \t]+${NPM_OPTION})*[ \t]+`;
const COMMANDS = [
  ['python -m unittest', String.raw`python(?:3(?:\.\p{Nd}+)?)?\s+-m\s+unittest`],
  ['npm test', String.raw`${NPM_LEAD}(?:(?:run[ \t]+)?test|t)`],
  ['npm run', `${NPM_LEAD}run`],
  ['cargo test', String.raw`cargo\s+test`],
  ['go test', String.raw`go\s+test`],
  ['make test', String.raw`make\s+test`],
  ['dotnet test', String.raw`dotnet\s+test`],
  ['pytest', 'pytest'],
  ['unittest', 'unittest'],
  ['vitest', 'vitest'],
  ['npx', 'npx'],
  ['mvn', 'mvnw?'],
  ['gradle', 'gradlew?'],
] as const;
const COMMAND_PATTERNS = COMMANDS.map(([name, pattern]) => ({
  name,
  regex: new RegExp(`${WORD_START}(?:${pattern})${WORD_END}`, 'giu'),
}));

function parseHeading(line: string): Heading | undefined {
  const heading = HEADING.exec(line);
  const bold = heading ? null : BOLD_HEADING.exec(line);
  const rawLabel = heading?.[1] ?? bold?.[1];
  if (rawLabel === undefined) return undefined;

  const label = rawLabel.trim()
    .replace(/^[*_`]+|[*_`]+$/g, '').trim()
    .replace(/#+$/, '').trim()
    .replace(/^\p{Nd}+[.)]\s+/u, '')
    .replace(/\s+/g, ' ')
    .replace(/[:：]+$/, '').trim();
  for (const { name, pattern } of SECTIONS) {
    const match = pattern.exec(label);
    if (!match) continue;

    const tail = label.slice(match[0].length).trimStart();
    const inlineBody = /^[:：—–-]/.test(tail) ? tail.replace(INLINE_SEPARATORS, '') : '';
    const followingBody = (bold?.[2] ?? '').replace(INLINE_SEPARATORS, '');
    return { label, section: name, body: [inlineBody, followingBody].filter(Boolean).join(' ') };
  }
  return heading ? { label, body: '' } : undefined;
}

function detectCommands(text: string): string[] {
  const matches = COMMAND_PATTERNS.flatMap(({ name, regex }) =>
    Array.from(text.matchAll(regex), (match) => ({
      name,
      start: match.index,
      end: match.index + match[0].length,
    })),
  );
  // Prefer the longest match at the same position, e.g. npm run test over npm run.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const detected = new Set<string>();
  let coveredUntil = -1;
  for (const { name, start, end } of matches) {
    if (start < coveredUntil) continue;
    detected.add(name);
    coveredUntil = end;
  }
  return [...detected];
}

function logicalCommands(lines: string[]): string[] {
  const commands: string[] = [];
  let pending = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    pending = pending ? `${pending} ${trimmed}` : trimmed;
    if (pending.endsWith('\\')) {
      pending = pending.slice(0, -1).trimEnd();
    } else {
      commands.push(pending);
      pending = '';
    }
  }
  if (pending) commands.push(pending);
  return commands;
}

function looksLikeJson(lines: string[]): boolean {
  const text = lines.join('\n').trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  try {
    // Python's JSON loader accepts these values in plain fenced output.
    const json = text.replace(/"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g, (token) =>
      token.startsWith('"') ? token : 'null',
    );
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}

function commandsInFence({ language, lines }: Fence, allowCustom: boolean): string[] {
  if (language.startsWith('json') || language === 'ndjson') return [];
  if (PLAIN_LANGUAGES.has(language) && looksLikeJson(lines)) return [];

  const shell = SHELL_LANGUAGES.has(language);
  const commands = shell ? logicalCommands(lines) : lines.map((line) => line.trim()).filter(Boolean);
  return commands.flatMap((command) => {
    const detected = detectCommands(command);
    return detected.length === 0 && allowCustom && (shell || commands.length === 1) ? [command] : detected;
  });
}

function parseDocument(markdown: string) {
  const sections: Partial<Record<Section, string[]>> = {};
  const headings: string[] = [];
  const commands = new Set<string>();
  let section: Section | undefined;
  let fence: Fence | undefined;

  for (const line of markdown.split(LINE_BREAK)) {
    const [, delimiter, info] = FENCE.exec(line) ?? [];
    if (fence) {
      if (delimiter?.startsWith(fence.marker) && delimiter.length >= fence.length && !info.trim()) {
        commandsInFence(fence, section === 'acceptance').forEach((command) => commands.add(command));
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    if (delimiter && !(delimiter[0] === '`' && info.includes('`'))) {
      const language = info.trim().split(/\s+/, 1)[0].replace(/^[{}]+|[{}]+$/g, '').replace(/^\.+/, '');
      fence = { marker: delimiter[0], length: delimiter.length, language: language.toLowerCase(), lines: [] };
      continue;
    }

    detectCommands(line).forEach((command) => commands.add(command));
    const heading = parseHeading(line);
    if (heading) {
      headings.push(heading.label);
      section = heading.section;
      if (section) (sections[section] ??= []).push(heading.body);
    } else if (section) {
      sections[section]?.push(line);
    }
  }
  if (fence) commandsInFence(fence, false).forEach((command) => commands.add(command));
  return { sections, headings, detectedCommands: [...commands] };
}

export function checkRfcReadiness(rfcMarkdown: string): RfcReadinessResult {
  const { sections, headings, detectedCommands } = parseDocument(rfcMarkdown);
  const missingSections = SECTIONS.filter(({ name }) => !sections[name]).map(({ name }) => name);
  const warnings = AMBIGUITY_MARKERS.filter(([, pattern]) => pattern.test(rfcMarkdown))
    .map(([marker]) => `Ambiguity marker '${marker}' found.`);

  if (headings.some((heading) => heading.includes('?'))) {
    warnings.push('Question mark found in a heading.');
  }
  if (sections.goal) {
    const goal = sections.goal.join(' ').replace(/\s+/g, ' ').trim();
    if (Array.from(goal).length < 40) warnings.push('Goal is shorter than 40 characters.');
  }
  if (sections.acceptance && !sections.acceptance.some((line) => NUMBERED_ITEM.test(line))) {
    warnings.push('Acceptance criteria are not numbered.');
  }

  const sectionScore = SECTIONS.reduce((score, { name, weight }) => score + (sections[name] ? weight : 0), 0);
  const commandScore = detectedCommands.length ? 20 : 0;
  const score = Math.max(0, sectionScore + commandScore - 5 * warnings.length);
  return {
    score,
    safe_for_overnight: score >= 70 && missingSections.length === 0 && detectedCommands.length > 0,
    missing_sections: missingSections,
    warnings,
    detected_commands: detectedCommands,
  };
}

export function generateStructuredRfc({
  goal,
  constraints = '',
  acceptance_cmd = '',
  non_goals = '',
}: RfcBrainstormRequest): RfcBrainstormResult {
  const command = acceptance_cmd.trim();
  let acceptance = 'TODO: add numbered acceptance criteria and a concrete verification command.';
  if (command) {
    let fenceLength = 3;
    for (const [backticks] of command.matchAll(/`{3,}/g)) {
      fenceLength = Math.max(fenceLength, backticks.length + 1);
    }
    const fence = '`'.repeat(fenceLength);
    acceptance = `1. The verification command exits successfully.\n\n${fence}bash\n${command}\n${fence}`;
  }
  const rfc_markdown = [
    '# RFC', '',
    '## Goal', '', goal.trim(), '',
    '## Constraints', '', constraints.trim(), '',
    '## Non-goals', '', non_goals.trim(), '',
    '## Acceptance Criteria', '', acceptance, '',
  ].join('\n');

  return { rfc_markdown, readiness: checkRfcReadiness(rfc_markdown) };
}
