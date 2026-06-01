export type Money = {
    amountMinor: bigint;
    currency: string;
};
export declare function toMinor(amountMajor: number | string, minorUnit: number): bigint;
export declare function toMajor(amountMinor: bigint, minorUnit: number): string;
export declare function formatMoney(money: Money, minorUnit: number, locale?: string): string;
//# sourceMappingURL=money.d.ts.map