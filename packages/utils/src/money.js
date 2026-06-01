// Money is stored everywhere as integer minor units + ISO 4217 currency code (e.g. 12345 + "USD" = $123.45).
// Major-unit conversion uses per-currency minor_unit count from the Currency lookup table.
export function toMinor(amountMajor, minorUnit) {
    const s = typeof amountMajor === 'number' ? amountMajor.toString() : amountMajor.trim();
    const sign = s.startsWith('-') ? -1n : 1n;
    const abs = s.replace(/^-/, '');
    const [intPart, fracPart = ''] = abs.split('.');
    const fracPadded = (fracPart + '0'.repeat(minorUnit)).slice(0, minorUnit);
    return sign * (BigInt(intPart || '0') * 10n ** BigInt(minorUnit) + BigInt(fracPadded || '0'));
}
export function toMajor(amountMinor, minorUnit) {
    const negative = amountMinor < 0n;
    const abs = negative ? -amountMinor : amountMinor;
    const divisor = 10n ** BigInt(minorUnit);
    const intPart = abs / divisor;
    const fracPart = (abs % divisor).toString().padStart(minorUnit, '0');
    const formatted = minorUnit > 0 ? `${intPart}.${fracPart}` : intPart.toString();
    return negative ? `-${formatted}` : formatted;
}
export function formatMoney(money, minorUnit, locale = 'en-US') {
    const major = Number(toMajor(money.amountMinor, minorUnit));
    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: money.currency,
        minimumFractionDigits: minorUnit,
        maximumFractionDigits: minorUnit,
    }).format(major);
}
//# sourceMappingURL=money.js.map