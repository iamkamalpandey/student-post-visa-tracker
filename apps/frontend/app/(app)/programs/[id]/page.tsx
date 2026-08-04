import type { Metadata } from 'next';
import Client from './Client';

// SVT-QA-2026-08 — user-facing label is "Course" across the app; keep this
// browser-tab title consistent with sidebar/heading terminology.
export const metadata: Metadata = {
  title: 'Course',
};

export default function Page() {
  return <Client />;
}
