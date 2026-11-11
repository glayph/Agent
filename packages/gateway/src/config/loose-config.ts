/**
 * The runtime config is user-supplied YAML that is validated by `@miki/config`; every level may be
 * missing. Call sites read single values defensively (`?.`, `=== true`, `Number(...)`), so they use
 * this one deliberately loose alias instead of repeating `any` at each read.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseConfig = any;
