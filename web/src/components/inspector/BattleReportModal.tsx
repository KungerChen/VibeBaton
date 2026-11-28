import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BatonApiClient } from '../../api/client';
import { MESSAGES, type Locale } from '../../i18n/messages';
import { Button } from '../ui/button';
import { MarkdownView } from '../ui/MarkdownView';
import { Modal } from '../ui/Modal';

export interface BattleReport {
  runId: string;
  lang: Locale;
  markdown: string;
}

type ReportToast = (message: string, kind?: 'ok' | 'err') => void;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a run's battle report on request and again when the language changes while it is open. */
export function useBattleReport(
  client: Pick<BatonApiClient, 'getRunReport'>,
  locale: Locale,
  onToast: ReportToast,
  visible = true,
) {
  const [report, setReport] = useState<BattleReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !report || report.lang === locale) return;
    let active = true;
    const targetRunId = report.runId;
    setLoading(true);
    void client.getRunReport(targetRunId, locale).then(
      (markdown) => {
        if (active) setReport({ runId: targetRunId, lang: locale, markdown });
      },
      (error) => {
        if (active) onToast(errorText(error), 'err');
      },
    ).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [client, locale, onToast, report, visible]);

  async function show(runId: string) {
    if (loading) return;
    setLoading(true);
    try {
      const markdown = await client.getRunReport(runId, locale);
      setReport({ runId, lang: locale, markdown });
    } catch (error) {
      onToast(errorText(error), 'err');
    } finally {
      setLoading(false);
    }
  }

  return { report, loading, show, close: () => setReport(null) };
}

/** The battle report of one run, rendered or as raw Markdown, with a copy button; Pro and the workbench share it. */
export function BattleReportModal({ report, locale, onClose, onToast }: {
  report: BattleReport;
  locale: Locale;
  onClose(): void;
  onToast: ReportToast;
}) {
  const messages = MESSAGES[locale];
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (copyTimer.current !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(copyTimer.current);
    }
  }, []);

  async function copyMarkdown() {
    try {
      await navigator.clipboard?.writeText(report.markdown);
      setCopied(true);
      if (copyTimer.current !== undefined && typeof window !== 'undefined') {
        window.clearTimeout(copyTimer.current);
      }
      if (typeof window !== 'undefined') {
        copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
      }
      onToast(messages.toasts.reportCopied, 'ok');
    } catch (error) {
      onToast(errorText(error), 'err');
    }
  }

  return (
    <Modal open wide title={messages.inspector.modalReportTitle} onClose={onClose}>
      <div className="right-inspector__report-toolbar">
        <code className="text-xs font-mono text-muted-foreground">{report.runId}</code>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={!rawMode ? 'default' : 'outline'}
            size="sm"
            aria-pressed={!rawMode}
            onClick={() => setRawMode(false)}
          >
            {messages.inspector.reportRendered}
          </Button>
          <Button
            variant={rawMode ? 'default' : 'outline'}
            size="sm"
            aria-pressed={rawMode}
            onClick={() => setRawMode(true)}
          >
            {messages.inspector.reportRaw}
          </Button>
          <Button variant="secondary" size="sm" aria-live="polite" onClick={() => void copyMarkdown()}>
            {copied ? (
              <>
                <Check size={14} aria-hidden="true" />
                <span>{messages.inspector.copiedInline}</span>
              </>
            ) : messages.inspector.reportCopy}
          </Button>
        </div>
      </div>
      {rawMode ? (
        <pre className="right-inspector__report right-inspector__mono">{report.markdown}</pre>
      ) : (
        <div className="right-inspector__report-body">
          <MarkdownView markdown={report.markdown} />
        </div>
      )}
    </Modal>
  );
}
