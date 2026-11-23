import { type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../../i18n';

const DIAGRAM_VIEW_BOX = '0 0 720 200';
const SVG_LAYOUT: CSSProperties = { display: 'block', height: 'auto' };

type DiagramTone = 'primary' | 'emerald' | 'amber';
type DiagramTextAnchor = 'start' | 'middle' | 'end';

const TONE_COLOR: Record<DiagramTone, string> = {
  primary: 'var(--primary)',
  emerald: 'var(--emerald)',
  amber: 'var(--amber)',
};

function splitLabel(label: string, maxChars: number): string[] {
  if (label.length <= maxChars) return [label];

  const words = label.split(' ');
  if (words.length === 1) {
    const chunks: string[] = [];
    for (let index = 0; index < label.length; index += maxChars) {
      chunks.push(label.slice(index, index + maxChars));
    }
    return chunks;
  }

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + word.length + 1 <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

interface SvgLabelProps {
  x: number;
  y: number;
  lines: readonly string[];
  fill: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  anchor?: DiagramTextAnchor;
}

function SvgLabel({
  x,
  y,
  lines,
  fill,
  fontSize = 10.5,
  fontWeight = 600,
  lineHeight = 13,
  anchor = 'middle',
}: SvgLabelProps) {
  const startY = y - ((lines.length - 1) * lineHeight) / 2;

  return (
    <text
      x={x}
      y={startY}
      fill={fill}
      fontSize={fontSize}
      fontWeight={fontWeight}
      textAnchor={anchor}
      dominantBaseline="middle"
    >
      {lines.map((line, index) => (
        <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? 0 : lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function ArrowMarker({ id, tone = 'primary' }: { id: string; tone?: DiagramTone }) {
  return (
    <defs>
      <marker
        id={id}
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 Z" fill={TONE_COLOR[tone]} />
      </marker>
    </defs>
  );
}

interface DiagramArrowProps {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  markerId: string;
  tone?: DiagramTone;
  both?: boolean;
  dashed?: boolean;
}

function DiagramArrow({
  x1,
  y1,
  x2,
  y2,
  markerId,
  tone = 'primary',
  both = false,
  dashed = false,
}: DiagramArrowProps) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={TONE_COLOR[tone]}
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray={dashed ? '5 4' : undefined}
      markerStart={both ? `url(#${markerId})` : undefined}
      markerEnd={`url(#${markerId})`}
    />
  );
}

interface DiagramBoxProps {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  tone?: DiagramTone;
  maxChars: number;
}

function DiagramBox({ x, y, width, height, label, tone = 'primary', maxChars }: DiagramBoxProps) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="10"
        fill="var(--card)"
        stroke="var(--border)"
        strokeWidth="1.5"
      />
      <rect x={x} y={y + 10} width="4" height={height - 20} rx="2" fill={TONE_COLOR[tone]} />
      <SvgLabel
        x={x + width / 2}
        y={y + height / 2}
        lines={splitLabel(label, maxChars)}
        fill="var(--foreground)"
      />
    </g>
  );
}

interface LiveSyncStageProps {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

function LiveSyncStage({ x, y, width, height, label }: LiveSyncStageProps) {
  const cardWidth = 48;
  const cardHeight = 28;
  const cardY = y + 9;
  const leftX = x + 14;
  const rightX = x + width - 14 - cardWidth;
  const syncY = cardY + cardHeight / 2;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx="10"
        fill="var(--card)"
        stroke="var(--border)"
        strokeWidth="1.5"
      />
      <rect x={x} y={y + 10} width="4" height={height - 20} rx="2" fill="var(--primary)" />

      <rect
        x={leftX}
        y={cardY}
        width={cardWidth}
        height={cardHeight}
        rx="6"
        fill="var(--card)"
        stroke="var(--primary)"
        strokeWidth="1.2"
      />
      <polygon
        points={`${leftX + 21},${cardY + 8} ${leftX + 31},${syncY} ${leftX + 21},${cardY + 20}`}
        fill="var(--primary)"
      />

      <rect
        x={rightX}
        y={cardY}
        width={cardWidth}
        height={cardHeight}
        rx="6"
        fill="var(--card)"
        stroke="var(--emerald)"
        strokeWidth="1.2"
      />
      <rect x={rightX + 17} y={cardY + 8} width="5" height="5" rx="1" fill="var(--primary)" />
      <rect x={rightX + 24} y={cardY + 8} width="5" height="5" rx="1" fill="var(--emerald)" />
      <rect x={rightX + 17} y={cardY + 15} width="5" height="5" rx="1" fill="var(--emerald)" />
      <rect x={rightX + 24} y={cardY + 15} width="5" height="5" rx="1" fill="var(--primary)" />

      <DiagramArrow
        x1={leftX + cardWidth + 4}
        y1={syncY}
        x2={rightX - 4}
        y2={syncY}
        markerId="guided-arrowhead"
        both
      />

      <SvgLabel
        x={x + width / 2}
        y={y + height - 16}
        lines={splitLabel(label, 24)}
        fill="var(--foreground)"
        fontSize={10}
        lineHeight={12}
      />
    </g>
  );
}

export interface DiagramFigureProps {
  caption: string;
  children: ReactNode;
}

export function DiagramFigure({ caption, children }: DiagramFigureProps) {
  return (
    <figure className="m-0 grid min-w-0 gap-2">
      <div
        className="min-w-0 overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&>svg]:min-w-[45rem]"
        role="group"
        aria-label={caption}
        tabIndex={0}
      >
        {children}
      </div>
      <figcaption style={{ color: 'var(--muted-foreground)', fontSize: '0.75rem', lineHeight: 1.5 }}>
        {caption}
      </figcaption>
    </figure>
  );
}

const RELAY_TONES: readonly DiagramTone[] = [
  'primary',
  'primary',
  'primary',
  'emerald',
  'primary',
  'emerald',
];

export function RelayPipelineDiagram() {
  const { messages } = useI18n();
  const copy = messages.tutorialDiagrams;
  const labels = [
    copy.l0User,
    copy.l1Planner,
    copy.l3Workers,
    copy.mechanicalGate,
    copy.l2Reviewer,
    copy.finalMerge,
  ];
  const boxWidth = 92;
  const boxHeight = 64;
  const boxY = 70;
  const gap = 28;
  const startX = 14;
  const centerY = boxY + boxHeight / 2;

  return (
    <DiagramFigure caption={copy.relayCaption}>
      <svg
        viewBox={DIAGRAM_VIEW_BOX}
        width="100%"
        role="img"
        aria-label={copy.relayAria}
        style={SVG_LAYOUT}
      >
        <title>{copy.relayCaption}</title>
        <ArrowMarker id="relay-arrowhead" />

        {labels.map((label, index) => {
          const x = startX + index * (boxWidth + gap);
          return (
            <g key={label}>
              <DiagramBox
                x={x}
                y={boxY}
                width={boxWidth}
                height={boxHeight}
                label={label}
                tone={RELAY_TONES[index]}
                maxChars={15}
              />
              {index < labels.length - 1 ? (
                <DiagramArrow
                  x1={x + boxWidth + 4}
                  y1={centerY}
                  x2={x + boxWidth + gap - 7}
                  y2={centerY}
                  markerId="relay-arrowhead"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
    </DiagramFigure>
  );
}

const GUIDED_TONES: readonly DiagramTone[] = ['primary', 'amber', 'primary', 'emerald'];

export function GuidedFlowDiagram() {
  const { messages } = useI18n();
  const copy = messages.tutorialDiagrams;
  const labels = [copy.budgetRecipe, copy.wizardGuards, copy.liveSync, copy.bilingualReport];
  const boxWidth = 156;
  const boxHeight = 84;
  const boxY = 58;
  const gap = 20;
  const startX = 18;
  const centerY = boxY + boxHeight / 2;

  return (
    <DiagramFigure caption={copy.guidedFlowCaption}>
      <svg
        viewBox={DIAGRAM_VIEW_BOX}
        width="100%"
        role="img"
        aria-label={copy.guidedFlowAria}
        style={SVG_LAYOUT}
      >
        <title>{copy.guidedFlowCaption}</title>
        <ArrowMarker id="guided-arrowhead" />

        {labels.map((label, index) => {
          const x = startX + index * (boxWidth + gap);
          return (
            <g key={label}>
              {index === 2 ? (
                <LiveSyncStage x={x} y={boxY} width={boxWidth} height={boxHeight} label={label} />
              ) : (
                <DiagramBox
                  x={x}
                  y={boxY}
                  width={boxWidth}
                  height={boxHeight}
                  label={label}
                  tone={GUIDED_TONES[index]}
                  maxChars={18}
                />
              )}
              {index < labels.length - 1 ? (
                <DiagramArrow
                  x1={x + boxWidth + 4}
                  y1={centerY}
                  x2={x + boxWidth + gap - 7}
                  y2={centerY}
                  markerId="guided-arrowhead"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
    </DiagramFigure>
  );
}

export function SandboxGuardDiagram() {
  const { messages } = useI18n();
  const copy = messages.tutorialDiagrams;
  const stackX = 22;
  const stackWidth = 176;
  const stackBoxHeight = 30;
  const stackTop = 34;
  const stackGap = 6;

  return (
    <DiagramFigure caption={copy.sandboxCaption}>
      <svg
        viewBox={DIAGRAM_VIEW_BOX}
        width="100%"
        role="img"
        aria-label={copy.sandboxAria}
        style={SVG_LAYOUT}
      >
        <title>{copy.sandboxCaption}</title>
        <ArrowMarker id="sandbox-arrowhead" />
        <ArrowMarker id="sandbox-blocked-arrowhead" tone="amber" />

        <SvgLabel
          x={stackX + stackWidth / 2}
          y={22}
          lines={splitLabel(copy.worktrees, 24)}
          fill="var(--muted-foreground)"
          fontWeight={700}
        />

        {[0, 1, 2].map((slot) => {
          const y = stackTop + slot * (stackBoxHeight + stackGap);
          return (
            <g key={slot}>
              <rect
                x={stackX}
                y={y}
                width={stackWidth}
                height={stackBoxHeight}
                rx="7"
                fill="var(--card)"
                stroke="var(--border)"
                strokeWidth="1.5"
              />
              <rect
                x={stackX}
                y={y + 7}
                width="4"
                height={stackBoxHeight - 14}
                rx="2"
                fill="var(--primary)"
              />
            </g>
          );
        })}

        <path
          d="M 252 38 L 280 48 V 78 C 280 98 269 108 252 114 C 235 108 224 98 224 78 V 48 Z"
          fill="var(--card)"
          stroke="var(--amber)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M 240 76 L 248 84 L 265 66"
          fill="none"
          stroke="var(--amber)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <SvgLabel
          x={252}
          y={128}
          lines={splitLabel(copy.whitelistRevert, 14)}
          fill="var(--foreground)"
        />

        <rect
          x={336}
          y={52}
          width={88}
          height={64}
          rx="10"
          fill="var(--card)"
          stroke="var(--emerald)"
          strokeWidth="2"
        />
        <SvgLabel
          x={380}
          y={84}
          lines={splitLabel(copy.mechanicalGate, 12)}
          fill="var(--foreground)"
        />

        <rect
          x={470}
          y={40}
          width={228}
          height={88}
          rx="12"
          fill="var(--card)"
          stroke="var(--emerald)"
          strokeWidth="2"
        />
        <rect
          x={486}
          y={78}
          width={16}
          height={12}
          rx="3"
          fill="none"
          stroke="var(--emerald)"
          strokeWidth="1.8"
        />
        <path
          d="M 490 78 V 73 a 5 5 0 0 1 10 0 V 78"
          fill="none"
          stroke="var(--emerald)"
          strokeWidth="1.8"
        />
        <circle cx="494" cy="84" r="1.5" fill="var(--emerald)" />
        <SvgLabel
          x={584}
          y={84}
          lines={splitLabel(copy.mainBranch, 22)}
          fill="var(--foreground)"
          fontSize={11.5}
          fontWeight={700}
        />

        <DiagramArrow x1={202} y1={84} x2={220} y2={84} markerId="sandbox-arrowhead" />
        <DiagramArrow x1={284} y1={84} x2={332} y2={84} markerId="sandbox-arrowhead" />
        <DiagramArrow x1={428} y1={84} x2={466} y2={84} markerId="sandbox-arrowhead" />

        <path
          d="M 198 134 C 248 184, 368 184, 436 154"
          fill="none"
          stroke="var(--amber)"
          strokeWidth="1.8"
          strokeDasharray="5 4"
          strokeLinecap="round"
          markerEnd="url(#sandbox-blocked-arrowhead)"
        />
        <circle
          cx={444}
          cy={154}
          r={8}
          fill="var(--card)"
          stroke="var(--amber)"
          strokeWidth="1.5"
        />
        <path
          d="M 440 150 L 448 158 M 448 150 L 440 158"
          stroke="var(--amber)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </DiagramFigure>
  );
}

export const TutorialDiagrams = {
  relay: RelayPipelineDiagram,
  guidedFlow: GuidedFlowDiagram,
  sandbox: SandboxGuardDiagram,
} as const;

export default TutorialDiagrams;
