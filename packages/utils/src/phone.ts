// Lightweight E.164 helpers; full parsing/formatting handled by libphonenumber-js in the apps.
// Goal here is shared validation primitives that both BE Zod schemas and FE form helpers can call.

const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

export function assertE164(value: string): string {
  if (!isE164(value)) {
    throw new Error(`Phone number is not in E.164 format: ${value}`);
  }
  return value;
}

export function stripPhoneFormatting(input: string): string {
  return input.replace(/[^\d+]/g, '');
}
