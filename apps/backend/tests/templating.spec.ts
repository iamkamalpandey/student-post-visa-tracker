// SVT-WAVE15-TEMPLATE-2026-05 — handlebars-lite template renderer.

import { describe, expect, it } from 'vitest';
import { renderTemplate, renderMessage, extractPlaceholders } from '../src/modules/comms/templating.js';

describe('renderTemplate', () => {
  it('substitutes top-level scalar placeholders', () => {
    expect(renderTemplate('Hello {{ name }}!', { name: 'Maya' })).toBe('Hello Maya!');
  });

  it('substitutes dot-path scalars', () => {
    expect(
      renderTemplate(
        'Dear {{ student.given_name }} {{ student.family_name }} ({{ student.student_code }})',
        { student: { given_name: 'Maya', family_name: 'Patel', student_code: 'SPV-2026-000123' } },
      ),
    ).toBe('Dear Maya Patel (SPV-2026-000123)');
  });

  it('empty string for unknown placeholder (never leaks {{var}})', () => {
    expect(renderTemplate('A:{{missing}}:B', { other: 1 })).toBe('A::B');
  });

  it('tolerates extra whitespace inside braces', () => {
    expect(renderTemplate('{{   foo   }}', { foo: 'bar' })).toBe('bar');
  });

  it('coerces number + boolean to string', () => {
    expect(renderTemplate('count={{n}} ok={{ok}}', { n: 42, ok: true })).toBe('count=42 ok=true');
  });

  it('renders objects + arrays as empty (not [object Object])', () => {
    expect(renderTemplate('x={{a}}', { a: { nested: 1 } })).toBe('x=');
    expect(renderTemplate('x={{a}}', { a: [1, 2] })).toBe('x=');
  });

  it('does NOT recurse — output containing {{var}} stays literal', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'should-not-resolve' })).toBe('{{b}}');
  });

  it('throws RangeError when rendered body exceeds maxBytes', () => {
    expect(() => renderTemplate('{{big}}', { big: 'x'.repeat(300_000) })).toThrow(RangeError);
  });
});

describe('renderMessage', () => {
  it('renders subject + body together', () => {
    const r = renderMessage('Re: {{ topic }}', 'Hi {{ name }}, {{ topic }} is ready.', {
      topic: 'visa',
      name: 'Maya',
    });
    expect(r.subject).toBe('Re: visa');
    expect(r.body).toBe('Hi Maya, visa is ready.');
  });

  it('null subject stays null', () => {
    const r = renderMessage(null, '{{ x }}', { x: 'y' });
    expect(r.subject).toBeNull();
    expect(r.body).toBe('y');
  });
});

describe('extractPlaceholders', () => {
  it('returns sorted unique placeholder names', () => {
    const list = extractPlaceholders('{{a}} {{b.c}} {{a}} {{d.e.f}}');
    expect(list).toEqual(['a', 'b.c', 'd.e.f']);
  });

  it('returns [] when no placeholders present', () => {
    expect(extractPlaceholders('static text only')).toEqual([]);
  });
});
