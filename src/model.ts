import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const LEVELS = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface ModelLike {
  provider: string;
  id: string;
}

export interface ResolveOptions<M> {
  /** Provider of the main session's model. Wins ties between providers. */
  preferProvider?: string;
  hasAuth: (model: M) => boolean;
}

export type Resolved<M> =
  | { ok: true; model: M; level?: ThinkingLevel }
  | { ok: false; error: string };

/**
 * Resolves a model spec: "provider/id", bare "id", each with an optional
 * ":level" suffix (e.g. "gpt-5.6-luna:high"). Bare ids that exist under
 * several providers prefer `preferProvider`, then providers with auth.
 */
export function resolveModel<M extends ModelLike>(
  spec: string,
  models: M[],
  options: ResolveOptions<M>,
): Resolved<M> {
  let ref = spec.trim();
  let level: ThinkingLevel | undefined;
  const colon = ref.lastIndexOf(":");
  if (colon > 0 && LEVELS.has(ref.slice(colon + 1))) {
    level = ref.slice(colon + 1) as ThinkingLevel;
    ref = ref.slice(0, colon);
  }
  const key = ref.toLowerCase();
  const full = (m: M) => `${m.provider}/${m.id}`.toLowerCase();

  const exact = models.find((m) => full(m) === key);
  if (exact) return { ok: true, model: exact, level };

  const rank = (m: M) =>
    (m.provider === options.preferProvider ? 2 : 0) +
    (options.hasAuth(m) ? 1 : 0);
  const byId = models
    .filter((m) => m.id.toLowerCase() === key)
    .sort((a, b) => rank(b) - rank(a));
  if (byId[0]) return { ok: true, model: byId[0], level };

  const near = models
    .filter((m) => full(m).includes(key))
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 5)
    .map((m) => `${m.provider}/${m.id}`);
  return {
    ok: false,
    error:
      `spawn: unknown model "${spec}". Use "provider/id" or a bare id, optionally with ":level".` +
      (near.length > 0 ? ` Close matches: ${near.join(", ")}` : ""),
  };
}
