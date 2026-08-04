// SVT-QA-2026-08 — shared frontend test setup.
//
// Kept intentionally small: jest-dom matchers, plus the two browser APIs jsdom
// does not implement that MUI touches on almost every render. Anything more
// specific belongs in the spec that needs it, so a reader can see a test's
// real dependencies without chasing global setup.

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// MUI's `useMediaQuery` (responsive Drawer/Grid) calls this on mount. jsdom has
// no layout engine, so it is absent. Default to "no match", i.e. the desktop
// breakpoint, which is what the components assume when no query matches.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// Some MUI transitions observe element size. jsdom lacks ResizeObserver.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
