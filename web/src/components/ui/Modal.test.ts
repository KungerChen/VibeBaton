import { describe, expect, test } from 'vitest';
import appSource from '../../App.tsx?raw';
import { canOpenModalDialog } from './Modal';

type FakeDialog = Pick<HTMLDialogElement, 'open'> & Partial<Pick<HTMLDialogElement, 'closest'>>;

function fakeDialog(overrides: { open?: boolean; hiddenAncestor?: boolean; withoutClosest?: boolean } = {}): FakeDialog {
  return {
    open: overrides.open ?? false,
    ...(overrides.withoutClosest
      ? {}
      : { closest: (selector: string) => (selector === '[hidden]' && overrides.hiddenAncestor ? ({} as Element) : null) }),
  };
}

describe('canOpenModalDialog', () => {
  test('allows showModal only when open, not already open, and not inside [hidden]', () => {
    expect(canOpenModalDialog(true, fakeDialog())).toBe(true);
    expect(canOpenModalDialog(true, fakeDialog({ withoutClosest: true }))).toBe(true);
    expect(canOpenModalDialog(true, fakeDialog({ hiddenAncestor: true }))).toBe(false);
    expect(canOpenModalDialog(true, fakeDialog({ open: true }))).toBe(false);
    expect(canOpenModalDialog(false, fakeDialog())).toBe(false);
    expect(canOpenModalDialog(true, null)).toBe(false);
  });
});

describe('App Pro overlay gating', () => {
  test('gates Pro modals and tour behind studioMode === "pro" so Guided Mode never becomes inert', () => {
    expect(appSource).toContain("open={studioMode === 'pro' && guideOpen}");
    expect(appSource).toContain("open={studioMode === 'pro' && transferModal === 'import'}");
    expect(appSource).toContain("open={studioMode === 'pro' && transferModal === 'export-recipe'}");
    expect(appSource).toContain("open={studioMode === 'pro' && transferModal === 'export-case'}");
    expect(appSource).toContain("{studioMode === 'pro' && mode === 'local' && startRunOpen && (");
    expect(appSource).toContain("{studioMode === 'pro' && tourState.open && (");
  });
});
