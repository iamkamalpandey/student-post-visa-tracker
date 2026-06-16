'use client';

// SVT-SYNC-2026-06 — section-level React error boundary.
// Wraps individual sections (visas, contacts, travel, etc.) so a JS crash in
// one section doesn't white-screen the entire student detail page. Renders a
// compact ErrorState with "Try again" instead of escalating to the route error.
//
// React error boundaries MUST be class components — there's no hook equivalent.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import ErrorState from './ErrorState';
import { reportBoundaryError } from '@/lib/reportError';

type Props = {
  /** Label for the boundary — used in error reporting. */
  section: string;
  children: ReactNode;
};

type State = { hasError: boolean };

export default class SectionErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reuse the existing sanitised error reporter (sendBeacon in prod, console in dev).
    reportBoundaryError('app' as never, Object.assign(error, {
      digest: `section:${this.props.section}`,
    }));
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error(`SectionErrorBoundary [${this.props.section}]`, error, info);
    }
  }

  handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorState
          title={`${this.props.section} failed to load`}
          description="An error occurred in this section. Other sections are unaffected."
          onRetry={this.handleRetry}
        />
      );
    }
    return this.props.children;
  }
}
