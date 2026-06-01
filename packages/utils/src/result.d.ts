export type Ok<T> = {
    ok: true;
    value: T;
};
export type Err<E> = {
    ok: false;
    error: E;
};
export type Result<T, E = Error> = Ok<T> | Err<E>;
export declare const ok: <T>(value: T) => Ok<T>;
export declare const err: <E>(error: E) => Err<E>;
//# sourceMappingURL=result.d.ts.map