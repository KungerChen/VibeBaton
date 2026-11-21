import './HeaderBar.css';
import './ui/ui.css';
import { Workflow } from 'lucide-react';
import type { HeaderBarProps } from './types';

export function HeaderBar({ mode, version, graphName }: HeaderBarProps) {
  const connected = mode === 'local';

  return (
    <header className="header-bar">
      <div className="header-bar__brand">
        <Workflow className="header-bar__icon" size={22} aria-hidden="true" />
        <span>VibeBaton</span>
      </div>
      <span className="header-bar__graph-name" title={graphName}>{graphName}</span>
      <span className={`header-bar__status pill ${connected ? 'pill--ok' : 'pill--warn'}`} role="status">
        <span className="header-bar__dot" aria-hidden="true" />
        <span>{connected ? 'Local Connected' : 'Standalone Demo'}</span>
        {connected && version && <span className="header-bar__version">{version}</span>}
      </span>
    </header>
  );
}
