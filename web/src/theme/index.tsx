import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createLiquidThemeController,
  LiquidWebAudioEngine,
  readStoredSoundEnabled,
  readStoredSoundVolume,
  SOUND_ENABLED_STORAGE_KEY,
  SOUND_VOLUME_STORAGE_KEY,
  type LiquidOrigin,
  type LiquidTheme,
  type LiquidThemeController,
} from '../liquid-theme';

export type Theme = LiquidTheme;

export const THEME_STORAGE_KEY = 'vibebaton.theme';

export function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export interface ThemeContextValue {
  theme: Theme;
  setTheme(next: Theme, origin?: LiquidOrigin): void;
  toggleTheme(origin?: LiquidOrigin): void;
  isTransitioning: boolean;
  soundEnabled: boolean;
  setSoundEnabled(enabled: boolean): void;
  soundVolume: number;
  setSoundVolume(volume: number): void;
  previewSound(): void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  setTheme: () => {},
  toggleTheme: () => {},
  isTransitioning: false,
  soundEnabled: false,
  setSoundEnabled: () => {},
  soundVolume: 0.45,
  setSoundVolume: () => {},
  previewSound: () => {},
});

function commitThemeSync(next: Theme) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = next;
    document.querySelectorAll('.react-flow').forEach((el) => {
      el.classList.remove('dark', 'light');
      el.classList.add(next);
    });
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors in restricted contexts.
    }
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() => readStoredSoundEnabled());
  const [soundVolume, setSoundVolumeState] = useState<number>(() => readStoredSoundVolume());

  const themeRef = useRef<Theme>(theme);
  themeRef.current = theme;
  const pendingThemeRef = useRef<Theme | null>(null);
  const audioRef = useRef<LiquidWebAudioEngine | null>(null);
  const controllerRef = useRef<LiquidThemeController | null>(null);

  if (!audioRef.current) {
    audioRef.current = new LiquidWebAudioEngine({
      enabled: soundEnabled,
      volume: soundVolume,
    });
  }

  if (!controllerRef.current) {
    controllerRef.current = createLiquidThemeController({
      durationMs: 1150,
      audio: audioRef.current,
      getSourceRoot: () => document.getElementById('root') ?? document.body,
      prepareClone: (cloneRoot, targetTheme) => {
        cloneRoot.querySelectorAll('.react-flow').forEach((el) => {
          el.classList.remove('dark', 'light');
          el.classList.add(targetTheme);
        });
      },
      onCommitTheme: (nextTheme) => {
        pendingThemeRef.current = null;
        themeRef.current = nextTheme;
        commitThemeSync(nextTheme);
        setThemeState(nextTheme);
        setIsTransitioning(false);
      },
    });
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        audioRef.current?.onInterrupt();
        setIsTransitioning(false);
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      controllerRef.current?.dispose();
    };
  }, []);

  const triggerTransition = useCallback((next: Theme, origin?: LiquidOrigin) => {
    const controller = controllerRef.current;
    if (!controller) {
      commitThemeSync(next);
      setThemeState(next);
      return;
    }

    const base = pendingThemeRef.current ?? themeRef.current;
    if (base === next) return;

    if (controller.isAnimating()) {
      controller.interrupt(true);
    }

    audioRef.current?.beginTransition();
    pendingThemeRef.current = next;
    setIsTransitioning(true);
    controller.trigger(themeRef.current, next, origin);
    if (!controller.isAnimating()) {
      // Immediate commit fallback (e.g. prefers-reduced-motion or unsupported browser).
      pendingThemeRef.current = null;
      setIsTransitioning(false);
    }
  }, []);

  const setTheme = useCallback(
    (next: Theme, origin?: LiquidOrigin) => {
      if (origin) {
        triggerTransition(next, origin);
        return;
      }
      controllerRef.current?.interrupt(false);
      pendingThemeRef.current = null;
      themeRef.current = next;
      commitThemeSync(next);
      setThemeState(next);
      setIsTransitioning(false);
    },
    [triggerTransition],
  );

  const toggleTheme = useCallback(
    (origin?: LiquidOrigin) => {
      const base = pendingThemeRef.current ?? themeRef.current;
      const next: Theme = base === 'dark' ? 'light' : 'dark';
      triggerTransition(next, origin);
    },
    [triggerTransition],
  );

  const setSoundEnabled = useCallback((enabled: boolean) => {
    setSoundEnabledState(enabled);
    if (enabled) void audioRef.current?.unlock();
    audioRef.current?.setEnabled(enabled);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, String(enabled));
      } catch {
        // Ignore storage errors in restricted contexts.
      }
    }
  }, []);

  const setSoundVolume = useCallback((volume: number) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0.45));
    setSoundVolumeState(clamped);
    audioRef.current?.setVolume(clamped);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(SOUND_VOLUME_STORAGE_KEY, String(clamped));
      } catch {
        // Ignore storage errors in restricted contexts.
      }
    }
  }, []);

  const previewSound = useCallback(() => {
    const current = pendingThemeRef.current ?? themeRef.current;
    const direction = current === 'dark' ? 'to-light' : 'to-dark';
    audioRef.current?.preview(direction);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      isTransitioning,
      soundEnabled,
      setSoundEnabled,
      soundVolume,
      setSoundVolume,
      previewSound,
    }),
    [
      theme,
      setTheme,
      toggleTheme,
      isTransitioning,
      soundEnabled,
      setSoundEnabled,
      soundVolume,
      setSoundVolume,
      previewSound,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
