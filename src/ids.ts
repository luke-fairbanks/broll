import { randomBytes } from 'node:crypto';

export type IdKind = 'ast' | 'dr' | 'rnd';

export type IdGenerator = (kind: IdKind) => string;

export const randomId: IdGenerator = (kind) => `${kind}_${randomBytes(5).toString('hex')}`;

/** Deterministic generator for tests: ast_000001, ast_000002, ... */
export function sequentialIds(): IdGenerator {
  const counters = new Map<IdKind, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_${String(next).padStart(6, '0')}`;
  };
}
