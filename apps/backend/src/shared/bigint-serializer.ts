// Side-effect import. Teaches JSON.stringify (and therefore Express res.json,
// pino, audit envelope-encryption) how to serialize BigInt: emit as decimal
// string. Money minor units exceed the 2^53 safe-integer range over time, so
// the wire format is always string. The frontend formatMoney already accepts
// string|bigint|number for this reason.
//
// Side-effects: mutating built-in prototypes is generally discouraged, but
// (a) TC39 has no objection (BigInt.prototype.toJSON is a missing-by-omission
// hole, not a deliberate exclusion) and (b) every Node.js project that ships
// money or large IDs ends up doing this. Centralised here so it's auditable.
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

if (typeof (BigInt.prototype as { toJSON?: unknown }).toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

export {};
