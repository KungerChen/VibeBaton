import './HeaderBar.css';
import './ui/ui.css';
import { Workflow } from 'lucide-react';
import { useI18n } from '../i18n';
import { translatePresetText } from '../i18n/presets';
import type { HeaderBarProps } from './types';

export function HeaderBar({ mode, version, graphName }: HeaderBarProps) {
  const { locale, setLocale, messages } = useI18n();
  const connected = mode === 'local';
  const localizedGraphName = translatePresetText(graphName, locale);

  return (
    <header className="header-bar">
      <div className="header-bar__brand">
        <Workflow className="header-bar__icon" size={22} aria-hidden="true" />
        <span>VibeBaton</span>
      </div>
      <span className="header-bar__graph-name" title={localizedGraphName}>
        {localizedGraphName}
      </span>
      <div className="header-bar__right">
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
