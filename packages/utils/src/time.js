// All API timestamps are ISO 8601 UTC. Render in the user's timezone at the edge.
export function nowUtcIso() {
    return new Date().toISOString();
}
export function isIsoDate(value) {
    // YYYY-MM-DD
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
export function isIsoDateTime(value) {
    return !Number.isNaN(Date.parse(value)) && /T/.test(value);
}
export function addDaysUtc(date, days) {
    const d = new Date(date.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}
//# sourceMappingURL=time.js.map