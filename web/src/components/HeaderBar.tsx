import './HeaderBar.css';
import './ui/ui.css';
import { BookOpen, Moon, Sun, Volume2, VolumeX, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { translatePresetText } from '../i18n/presets';
import { useTheme } from '../theme';
import type { HeaderBarProps } from './types';

export function HeaderBar({ mode, version, graphName, onOpenGuide }: HeaderBarProps) {
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
    <header className="header-bar">
      <div className="header-bar__brand">
        <Workflow className="header-bar__icon" size={20} aria-hidden="true" />
        <span>VibeBaton</span>
      </div>
      <span className="header-bar__graph-name" title={localizedGraphName}>
        {localizedGraphName}
      </span>
      <div className="header-bar__right">
        {onOpenGuide && (
          <>
            <button className="header-bar__guide-btn" type="button" onClick={onOpenGuide}>
              <BookOpen size={14} aria-hidden="true" />
              <span>{messages.header.guideButton}</span>
            </button>
            <span className="header-bar__divider" aria-hidden="true" />
          </>
        )}

        <div className="header-bar__sound-wrap" ref={soundWrapRef}>
          <button
            className={`header-bar__icon-btn${audible ? ' header-bar__icon-btn--accent' : ''}`}
            type="button"
            aria-label={messages.header.soundButtonAria}
            aria-expanded={soundOpen}
            title={messages.header.soundTitle}
            onClick={() => setSoundOpen((open) => !open)}
          >
            {audible ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
          </button>

          {soundOpen && (
            <div className="header-bar__sound-popover" role="dialog" aria-label={messages.header.soundTitle}>
              <div className="header-bar__sound-row">
                <span className="header-bar__sound-label">{messages.header.soundToggleLabel}</span>
                <button
                  className={`header-bar__sound-toggle${soundEnabled ? ' header-bar__sound-toggle--on' : ''}`}
                  type="button"
                  aria-pressed={soundEnabled}
                  onClick={() => setSoundEnabled(!soundEnabled)}
                >
                  {soundEnabled ? messages.header.soundOn : messages.header.soundOff}
                </button>
              </div>
              <label className="header-bar__sound-vol">
                <span className="header-bar__sound-row">
                  <span className="header-bar__sound-label">{messages.header.soundVolumeLabel}</span>
                  <span className="header-bar__sound-pct">{Math.round(soundVolume * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(soundVolume * 100)}
                  onChange={(event) => setSoundVolume(event.currentTarget.valueAsNumber / 100)}
                />
              </label>
              <button
                className="btn header-bar__sound-preview"
                type="button"
                onClick={previewSound}
              >
                <Volume2 size={13} aria-hidden="true" />
                <span>{messages.header.soundPreview}</span>
              </button>
            </div>
          )}
        </div>

        <button
          className="header-bar__theme-btn"
          type="button"
          aria-label={themeTooltip}
          title={themeTooltip}
          onClick={(event) => toggleTheme(event.currentTarget)}
        >
          {theme === 'dark' ? (
            <Sun className="header-bar__theme-icon" size={14} aria-hidden="true" />
          ) : (
            <Moon className="header-bar__theme-icon" size={14} aria-hidden="true" />
          )}
        </button>

        <div className="header-bar__lang" role="group" aria-label={messages.header.languageAria}>
          <button
            className={`header-bar__lang-btn${locale === 'en' ? ' header-bar__lang-btn--active' : ''}`}
            type="button"
            aria-pressed={locale === 'en'}
            onClick={() => setLocale('en')}
          >
            EN
          </button>
          <button
            className={`header-bar__lang-btn${locale === 'zh' ? ' header-bar__lang-btn--active' : ''}`}
            type="button"
            aria-pressed={locale === 'zh'}
            onClick={() => setLocale('zh')}
          >
            中文
          </button>
        </div>

        <span className={`header-bar__status pill ${connected ? 'pill--ok' : 'pill--warn'}`} role="status">
          <span className="header-bar__dot" aria-hidden="true" />
          <span>{connected ? messages.header.localConnected : messages.header.standaloneDemo}</span>
          {connected && version && <span className="header-bar__version">{version}</span>}
        </span>
      </div>
    </header>
  );
}
