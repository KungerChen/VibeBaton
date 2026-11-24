import './HeaderBar.css';
import './ui/ui.css';
import { BookOpen, Moon, Sun, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { translatePresetText } from '../i18n/presets';
import { cn } from '../lib/utils';
import { useTheme } from '../theme';
import type { HeaderBarProps } from './types';
import { Badge } from './ui/badge';
import { BrandMark } from './ui/BrandMark';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

export function HeaderBar({
  mode,
  version,
  graphName,
  replayActive = false,
  liveViewActive = false,
  onOpenStartRun,
  onOpenGuide,
}: HeaderBarProps) {
  const { locale, setLocale, messages } = useI18n();
  const {
    theme,
    toggleTheme,
    soundEnabled,
    setSoundEnabled,
    soundVolume,
    setSoundVolume,
    previewSound,
  } = useTheme();
  const [soundOpen, setSoundOpen] = useState(false);
  const soundWrapRef = useRef<HTMLDivElement>(null);
  const connected = mode === 'local';
  const localizedGraphName = translatePresetText(graphName, locale);
  const themeTooltip = theme === 'dark' ? messages.header.switchToLight : messages.header.switchToDark;
  const audible = soundEnabled && soundVolume > 0;

  useEffect(() => {
    if (!soundOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (soundWrapRef.current && !soundWrapRef.current.contains(event.target as Node)) {
        setSoundOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSoundOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [soundOpen]);

  return (
    <header className="header-bar border-b border-border bg-card">
      <div className="header-bar__brand flex shrink-0 items-center gap-2 text-text-strong">
        <span className="header-bar__logo flex h-7 w-7 shrink-0 items-center justify-center rounded-lg shadow-xs">
          <BrandMark size={28} />
        </span>
        <span className="text-[14.5px] font-bold tracking-tight">VibeBaton</span>
      </div>

      <span className="header-bar__sep hidden sm:inline text-border-strong select-none" aria-hidden="true">
        /
      </span>

      <span
        className="header-bar__graph-name truncate rounded-md border border-border/70 bg-muted/70 px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
        title={localizedGraphName}
      >
        {localizedGraphName}
      </span>

      {(liveViewActive || replayActive) && (
        <Badge
          variant={liveViewActive ? 'info' : 'violet'}
          className="header-bar__mode shrink-0 px-2 py-0.5 text-[10.5px]"
        >
          {liveViewActive ? messages.header.modeLive : messages.header.modeReplay}
        </Badge>
      )}

      <div className="header-bar__right" data-tour-id="header-controls">
        {connected && onOpenStartRun && (
          <>
            <Button
              variant="default"
              size="sm"
              className="header-bar__start-btn shrink-0"
              onClick={onOpenStartRun}
            >
              {messages.inspector.startRealRun}
            </Button>
            <span className="header-bar__divider" aria-hidden="true" />
          </>
        )}
        {onOpenGuide && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="header-bar__guide-btn"
              onClick={onOpenGuide}
            >
              <BookOpen size={14} aria-hidden="true" />
              <span>{messages.header.guideButton}</span>
            </Button>
            <span className="header-bar__divider" aria-hidden="true" />
          </>
        )}

        <div className="header-bar__sound-wrap" ref={soundWrapRef}>
          <Button
            variant="outline"
            size="icon-sm"
            className={cn(
              'header-bar__icon-btn',
              audible && 'border-primary/40 bg-[var(--accent-soft)] text-primary hover:bg-[var(--accent-soft)]',
            )}
            aria-label={messages.header.soundButtonAria}
            aria-expanded={soundOpen}
            title={messages.header.soundTitle}
            onClick={() => setSoundOpen((open) => !open)}
          >
            {audible ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
          </Button>

          {soundOpen && (
            <div
              className="header-bar__sound-popover rounded-xl border border-border-strong bg-popover text-popover-foreground shadow-[var(--shadow-lg)]"
              role="dialog"
              aria-label={messages.header.soundTitle}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-text-strong">
                  {messages.header.soundToggleLabel}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {soundEnabled ? messages.header.soundOn : messages.header.soundOff}
                  </span>
                  <Switch
                    checked={soundEnabled}
                    onCheckedChange={setSoundEnabled}
                    aria-label={messages.header.soundToggleLabel}
                  />
                </div>
              </div>

              <label className="header-bar__sound-vol flex flex-col gap-1.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-text-strong">
                    {messages.header.soundVolumeLabel}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
                    {Math.round(soundVolume * 100)}%
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(soundVolume * 100)}
                  onChange={(event) => setSoundVolume(event.currentTarget.valueAsNumber / 100)}
                />
              </label>

              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={previewSound}
              >
                <Volume2 size={13} aria-hidden="true" />
                <span>{messages.header.soundPreview}</span>
              </Button>
            </div>
          )}
        </div>

        <Button
          variant="outline"
          size="icon-sm"
          className="header-bar__theme-btn"
          aria-label={themeTooltip}
          title={themeTooltip}
          onClick={(event) => toggleTheme(event.currentTarget)}
        >
          {theme === 'dark' ? (
            <Sun className="header-bar__theme-icon" size={14} aria-hidden="true" />
          ) : (
            <Moon className="header-bar__theme-icon" size={14} aria-hidden="true" />
          )}
        </Button>

        <div
          className="header-bar__lang inline-flex items-center rounded-lg border border-border bg-muted p-0.5"
          role="group"
          aria-label={messages.header.languageAria}
        >
          <button
            className={cn(
              'rounded-md px-2 py-0.5 text-[11px] font-semibold transition-all cursor-pointer',
              locale === 'en'
                ? 'bg-card text-text-strong shadow-xs'
                : 'text-muted-foreground hover:text-text-strong',
            )}
            type="button"
            aria-pressed={locale === 'en'}
            onClick={() => setLocale('en')}
          >
            EN
          </button>
          <button
            className={cn(
              'rounded-md px-2 py-0.5 text-[11px] font-semibold transition-all cursor-pointer',
              locale === 'zh'
                ? 'bg-card text-text-strong shadow-xs'
                : 'text-muted-foreground hover:text-text-strong',
            )}
            type="button"
            aria-pressed={locale === 'zh'}
            onClick={() => setLocale('zh')}
          >
            中文
          </button>
        </div>

        <Badge
          variant={connected ? 'success' : 'warning'}
          className="header-bar__status shrink-0 px-2.5 py-1 text-[11px]"
          role="status"
        >
          <span
            className={cn('h-1.5 w-1.5 rounded-full bg-current', connected && 'animate-pulse')}
            aria-hidden="true"
          />
          <span>{connected ? messages.header.localConnected : messages.header.standaloneDemo}</span>
          {connected && version && <span className="opacity-70 font-mono">{version}</span>}
        </Badge>
      </div>
    </header>
  );
}
