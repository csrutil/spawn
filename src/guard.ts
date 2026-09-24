/** A bash command that does nothing but sleep, e.g. `sleep 20` or `sleep 1m`. */
export const PURE_SLEEP = /^\s*sleep\s+[\d.]+[smhd]?\s*;?\s*$/;
