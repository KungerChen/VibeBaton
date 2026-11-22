import './MarkdownView.css';
import { Fragment, type ReactNode } from 'react';

export type TableAlign = 'left' | 'center' | 'right';

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; alignments: TableAlign[]; rows: string[][] }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'hr' };

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'link'; label: string; href: string };

const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$|^\s*\|\s*:?-{3,}:?\s*\|\s*$/;
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*$/;
const FENCE_RE = /^```([a-zA-Z0-9_-]*)\s*$/;
const HR_RE = /^(?:---+|___+|\*\*\*+)\s*$/;
const UL_RE = /^[-*+]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const INLINE_RE = /(`[^`]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseTableAlignments(line: string, colCount: number): TableAlign[] {
  const cells = splitTableRow(line);
  return Array.from({ length: colCount }, (_, index) => {
    const cell = cells[index] ?? '';
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function isBlockStart(line: string, nextLine: string | undefined): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (HEADING_RE.test(trimmed) || FENCE_RE.test(trimmed) || HR_RE.test(trimmed)) return true;
  if (UL_RE.test(trimmed) || OL_RE.test(trimmed) || QUOTE_RE.test(trimmed)) return true;
  if (trimmed.includes('|') && nextLine !== undefined && TABLE_SEPARATOR_RE.test(nextLine.trim())) return true;
  return false;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      const language = fenceMatch[1] ?? '';
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', language, code: codeLines.join('\n') });
      continue;
    }

    const headingMatch = HEADING_RE.exec(trimmed);
    if (headingMatch) {
      blocks.push({
        kind: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3 | 4,
        text: headingMatch[2],
      });
      i += 1;
      continue;
    }

    if (HR_RE.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    const nextLine = lines[i + 1];
    if (trimmed.includes('|') && nextLine !== undefined && TABLE_SEPARATOR_RE.test(nextLine.trim())) {
      const headers = splitTableRow(trimmed);
      const alignments = parseTableAlignments(nextLine, headers.length);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        const rawCells = splitTableRow(lines[i]);
        const normalized = Array.from({ length: headers.length }, (_, idx) => rawCells[idx] ?? '');
        rows.push(normalized);
        i += 1;
      }
      blocks.push({ kind: 'table', headers, alignments, rows });
      continue;
    }

    if (QUOTE_RE.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i].trim())) {
        const match = QUOTE_RE.exec(lines[i].trim());
        quoteLines.push(match?.[1] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    const ulMatch = UL_RE.exec(trimmed);
    if (ulMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const match = UL_RE.exec(lines[i].trim());
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: false, items });
      continue;
    }

    const olMatch = OL_RE.exec(trimmed);
    if (olMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const match = OL_RE.exec(lines[i].trim());
        if (!match) break;
        items.push(match[1]);
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: true, items });
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      if (paraLines.length > 0 && isBlockStart(lines[i], lines[i + 1])) break;
      paraLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

export function tokenizeInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      tokens.push({ kind: 'text', value: text.slice(cursor, idx) });
    }
    const raw = match[0];
    if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ kind: 'code', value: raw.slice(1, -1) });
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push({ kind: 'bold', value: raw.slice(2, -2) });
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push({ kind: 'italic', value: raw.slice(1, -1) });
    } else {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(raw);
      if (linkMatch) {
        tokens.push({ kind: 'link', label: linkMatch[1], href: linkMatch[2] });
      } else {
        tokens.push({ kind: 'text', value: raw });
      }
    }
    cursor = idx + raw.length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: 'text', value: text.slice(cursor) });
  }
  return tokens;
}

function renderInline(text: string): ReactNode {
  return tokenizeInlineMarkdown(text).map((token, idx) => {
    switch (token.kind) {
      case 'text':
        return <Fragment key={idx}>{token.value}</Fragment>;
      case 'code':
        return <code key={idx}>{token.value}</code>;
      case 'bold':
        return <strong key={idx}>{token.value}</strong>;
      case 'italic':
        return <em key={idx}>{token.value}</em>;
      case 'link':
        return (
          <a key={idx} href={token.href} target="_blank" rel="noreferrer">
            {token.label}
          </a>
        );
    }
  });
}

export function MarkdownView({ markdown }: { markdown: string }) {
  const blocks = parseMarkdownBlocks(markdown);

  return (
    <div className="markdown-view">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${block.level}` as const;
            return <Tag key={index}>{renderInline(block.text)}</Tag>;
          }
          case 'paragraph':
            return <p key={index}>{renderInline(block.text)}</p>;
          case 'blockquote':
            return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
          case 'hr':
            return <hr key={index} />;
          case 'code':
            return (
              <pre key={index}>
                <code>{block.code}</code>
              </pre>
            );
          case 'list': {
            const ListTag = block.ordered ? 'ol' : 'ul';
            return (
              <ListTag key={index}>
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ListTag>
            );
          }
          case 'table':
            return (
              <div className="markdown-view__table-wrap" key={index}>
                <table className="markdown-view__table">
                  <thead>
                    <tr>
                      {block.headers.map((header, colIdx) => (
                        <th key={colIdx} style={{ textAlign: block.alignments[colIdx] }}>
                          {renderInline(header)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIdx) => (
                      <tr key={rowIdx}>
                        {row.map((cell, colIdx) => (
                          <td key={colIdx} style={{ textAlign: block.alignments[colIdx] }}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
