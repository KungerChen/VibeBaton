import type { LiquidTheme } from './types';

export interface LiquidOverlayHandle {
  clipPathEl: SVGPathElement;
  rimPathEl: SVGPathElement;
  destroy(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ID_LIST_ATTRS = ['for', 'list', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'] as const;
const URL_REF_ATTRS = ['clip-path', 'marker-start', 'marker-mid', 'marker-end', 'fill', 'stroke', 'mask', 'filter', 'style'] as const;

export function supportsSvgClipPath(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof SVGClipPathElement === 'undefined') return false;
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
      return CSS.supports('clip-path', 'url(#liquid-probe)') || CSS.supports('-webkit-clip-path', 'url(#liquid-probe)');
    }
  } catch {
    return true;
  }
  return true;
}

function remapIntraCloneReferences(cloneRoot: HTMLElement, idPrefix: string): void {
  const idMap = new Map<string, string>();
  const allElements: Element[] = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll('*'))];

  for (const el of allElements) {
    const existingId = el.getAttribute('id');
    if (!existingId) continue;
    const mapped = `${idPrefix}${existingId}`;
    idMap.set(existingId, mapped);
    el.setAttribute('id', mapped);
  }

  if (idMap.size === 0) return;

  for (const el of allElements) {
    for (const attr of ID_LIST_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      let changed = false;
      const tokens = value.split(/\s+/).map((token) => {
        const mapped = idMap.get(token);
        if (!mapped) return token;
        changed = true;
        return mapped;
      });
      if (changed) el.setAttribute(attr, tokens.join(' '));
    }

    for (const attr of ['href', 'xlink:href'] as const) {
      const value = el.getAttribute(attr);
      if (!value || !value.startsWith('#')) continue;
      const mapped = idMap.get(value.slice(1));
      if (mapped) el.setAttribute(attr, `#${mapped}`);
    }

    for (const attr of URL_REF_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value || !value.includes('#')) continue;
      let changed = false;
      const replaced = value.replace(/url\(\s*(["']?)#([^)"'\s]+)\1\s*\)/g, (full, quote: string, refId: string) => {
        const mapped = idMap.get(refId);
        if (!mapped) return full;
        changed = true;
        return `url(${quote}#${mapped}${quote})`;
      });
      if (changed) el.setAttribute(attr, replaced);
    }
  }
}

export function createRevealOverlay(
  sourceRoot: HTMLElement,
  mountTarget: HTMLElement,
  targetTheme: LiquidTheme,
  clipId: string,
  prepareClone?: (cloneRoot: HTMLElement, targetTheme: LiquidTheme) => void,
): LiquidOverlayHandle {
  // Batch layout/state reads from the live tree before creating/appending any clone nodes.
  const rootRect = sourceRoot.getBoundingClientRect();
  const sourceElements: Element[] = [sourceRoot, ...Array.from(sourceRoot.querySelectorAll('*'))];
  const scrollSnapshots: { index: number; top: number; left: number }[] = [];

  for (let i = 0; i < sourceElements.length; i += 1) {
    const el = sourceElements[i];
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      scrollSnapshots.push({ index: i, top: el.scrollTop, left: el.scrollLeft });
    }
  }

  const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement;
  const cloneElements: Element[] = [cloneRoot, ...Array.from(cloneRoot.querySelectorAll('*'))];
  const count = Math.min(sourceElements.length, cloneElements.length);

  for (let i = 0; i < count; i += 1) {
    const src = sourceElements[i];
    const dst = cloneElements[i];

    if (src instanceof HTMLInputElement && dst instanceof HTMLInputElement) {
      dst.value = src.value;
      dst.checked = src.checked;
      dst.indeterminate = src.indeterminate;
    } else if (src instanceof HTMLTextAreaElement && dst instanceof HTMLTextAreaElement) {
      dst.value = src.value;
    } else if (src instanceof HTMLSelectElement && dst instanceof HTMLSelectElement) {
      dst.selectedIndex = src.selectedIndex;
      for (let opt = 0; opt < src.options.length && opt < dst.options.length; opt += 1) {
        dst.options[opt].selected = src.options[opt].selected;
      }
    } else if (dst instanceof HTMLMediaElement) {
      dst.muted = true;
      dst.autoplay = false;
      try {
        dst.pause();
      } catch {
        // Ignore paused/unloaded media errors.
      }
    }
  }

  remapIntraCloneReferences(cloneRoot, `${clipId}-`);
  prepareClone?.(cloneRoot, targetTheme);

  const overlay = document.createElement('div');
  overlay.dataset.liquidRevealOverlay = 'true';
  overlay.dataset.theme = targetTheme;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = true;
  overlay.tabIndex = -1;
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100%',
    'height: 100%',
    'z-index: 2147483640',
    'pointer-events: none',
    'overflow: hidden',
    'contain: layout style paint',
    `clip-path: url(#${clipId})`,
    `-webkit-clip-path: url(#${clipId})`,
  ].join(';');

  const cloneViewportFrame = document.createElement('div');
  cloneViewportFrame.style.cssText = [
    'position: fixed',
    `left: ${rootRect.left}px`,
    `top: ${rootRect.top}px`,
    `width: ${rootRect.width}px`,
    `height: ${rootRect.height}px`,
    'overflow: hidden',
    'pointer-events: none',
  ].join(';');

  cloneRoot.style.margin = '0';
  cloneRoot.style.width = '100%';
  cloneRoot.style.height = '100%';
  cloneViewportFrame.append(cloneRoot);
  overlay.append(cloneViewportFrame);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.liquidRevealSvg = 'true';
  svg.style.cssText = [
    'position: fixed',
    'inset: 0',
    'width: 100vw',
    'height: 100vh',
    'z-index: 2147483641',
    'pointer-events: none',
    'overflow: visible',
  ].join(';');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const clipPath = document.createElementNS(SVG_NS, 'clipPath');
  clipPath.setAttribute('id', clipId);
  clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse');

  const clipPathEl = document.createElementNS(SVG_NS, 'path');
  clipPathEl.setAttribute('clip-rule', 'nonzero');
  clipPath.append(clipPathEl);
  defs.append(clipPath);
  svg.append(defs);

  const rimPathEl = document.createElementNS(SVG_NS, 'path');
  rimPathEl.setAttribute('fill', 'none');
  rimPathEl.setAttribute('stroke', targetTheme === 'light' ? 'rgba(37, 99, 235, 0.32)' : 'rgba(59, 130, 246, 0.38)');
  rimPathEl.setAttribute('stroke-width', '2');
  rimPathEl.setAttribute('stroke-linecap', 'round');
  svg.append(rimPathEl);

  mountTarget.append(overlay, svg);

  // Restore scroll positions only after the overlay is attached to the document.
  for (const entry of scrollSnapshots) {
    const dst = cloneElements[entry.index];
    if (dst) {
      dst.scrollTop = entry.top;
      dst.scrollLeft = entry.left;
    }
  }

  let destroyed = false;
  return {
    clipPathEl,
    rimPathEl,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      overlay.remove();
      svg.remove();
    },
  };
}
