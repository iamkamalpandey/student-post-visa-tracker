'use client';

// SVT-WAVE-POLISH-2026-05 — App-wide keyboard navigation.
//
// Bindings:
//   g s     Go to Students
//   g d     Go to Dashboard
//   g i     Go to Inbox
//   c       Create student (broadcasts `spv:open-create-student` window event)
//   /       Focus the command palette search (dispatches Cmd-K)
//
// "g" is a leader key; the second key must be pressed within 800ms.
// Bindings are disabled while a text input / textarea / contenteditable has
// focus so typing in a form doesn't get hijacked.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const LEADER_TIMEOUT_MS = 800;

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

export default function KeyboardShortcuts() {
  const router = useRouter();

  useEffect(() => {
    let leaderArmedAt = 0;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const key = e.key.toLowerCase();

      // `/` focuses the command palette by re-dispatching Cmd-K — the palette
      // already owns its open state and focus management.
      if (key === '/') {
        e.preventDefault();
        const synth = new KeyboardEvent('keydown', { key: 'k', metaKey: true });
        window.dispatchEvent(synth);
        return;
      }

      // `c` opens the create-student modal on whichever surface listens.
      if (key === 'c') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('spv:open-create-student'));
        return;
      }

      // Leader-key sequence `g <something>`.
      if (leaderArmedAt && Date.now() - leaderArmedAt < LEADER_TIMEOUT_MS) {
        leaderArmedAt = 0;
        if (key === 's') {
          e.preventDefault();
          router.push('/students');
          return;
        }
        if (key === 'd') {
          e.preventDefault();
          router.push('/');
          return;
        }
        if (key === 'i') {
          e.preventDefault();
          router.push('/inbox');
          return;
        }
        return;
      }
      if (key === 'g') {
        leaderArmedAt = Date.now();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return null;
}
