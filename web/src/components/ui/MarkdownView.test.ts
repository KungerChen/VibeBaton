import { describe, expect, test } from 'vitest';
import { parseMarkdownBlocks, tokenizeInlineMarkdown } from './MarkdownView';

const SAMPLE_BATTLE_REPORT = `# VibeBaton Run Report — \`run-20261121-081454-e815d5\`

- **Status**: \`READY_FOR_FINAL_GATE\`
- **Tasks**: \`15/15\` passed

## Efficiency & Guardrail Highlights

| Metric | Value | Why It Matters |
| :--- | :---: | ---: |
| Mechanical Gate Catches | **0** | Defects fixed locally |
| Circuit-Breaker Escalations | **2** | Handed off to Specialist tier |

## Task Breakdown

\`\`\`text
M1 -> M2 -> M3
\`\`\`

All 3 milestone(s) passed mechanical gates. [Docs](https://example.com) and [Bad](javascript:alert(1))`;

describe('MarkdownView parser', () => {
  test('parses headings, lists, aligned GFM tables, code blocks, and summary paragraphs', () => {
    const blocks = parseMarkdownBlocks(SAMPLE_BATTLE_REPORT);

    expect(blocks[0]).toEqual({
      kind: 'heading',
      level: 1,
      text: 'VibeBaton Run Report — `run-20261121-081454-e815d5`',
    });
    expect(blocks[1]).toEqual({
      kind: 'list',
      ordered: false,
      items: ['**Status**: `READY_FOR_FINAL_GATE`', '**Tasks**: `15/15` passed'],
    });
    expect(blocks[2]).toEqual({
      kind: 'heading',
      level: 2,
      text: 'Efficiency & Guardrail Highlights',
    });
    expect(blocks[3]).toEqual({
      kind: 'table',
      headers: ['Metric', 'Value', 'Why It Matters'],
      alignments: ['left', 'center', 'right'],
      rows: [
        ['Mechanical Gate Catches', '**0**', 'Defects fixed locally'],
        ['Circuit-Breaker Escalations', '**2**', 'Handed off to Specialist tier'],
      ],
    });
    expect(blocks[5]).toEqual({ kind: 'code', language: 'text', code: 'M1 -> M2 -> M3' });
    expect(blocks[6]).toMatchObject({ kind: 'paragraph' });
  });

  test('tokenizes inline code, bold, safe https links, and leaves unsafe URLs as plain text', () => {
    const tokens = tokenizeInlineMarkdown(
      '**Status**: `READY` · *note* · [Docs](https://example.com) · [Unsafe](javascript:alert(1))',
    );

    expect(tokens).toContainEqual({ kind: 'bold', value: 'Status' });
    expect(tokens).toContainEqual({ kind: 'code', value: 'READY' });
    expect(tokens).toContainEqual({ kind: 'italic', value: 'note' });
    expect(tokens).toContainEqual({ kind: 'link', label: 'Docs', href: 'https://example.com' });
    expect(tokens.some((token) => token.kind === 'link' && token.href.startsWith('javascript:'))).toBe(false);
  });
});
