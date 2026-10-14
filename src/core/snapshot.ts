const MAX_DEPTH = 64;

export class InvalidInputError extends Error {
  override name = "InvalidInputError";
}

/**
 * Copies `value` into a deeply frozen, JSON-shaped snapshot.
 *
 * Authorization is bound to this snapshot: policies, the approver and the
 * handler all receive the same frozen object, so the caller cannot change the
 * arguments after they were authorized (no check-then-mutate). Each property is
 * read exactly once, so getters cannot return one value to the policy and
 * another to the handler.
 *
 * Accepted: `null`, booleans, finite numbers, strings, arrays and plain
 * objects (prototype `Object.prototype` or `null`). Everything else — functions,
 * symbols, bigint, class instances, Map/Set/Date, cycles, sparse arrays,
 * non-finite numbers, depth > 64 — is rejected.
 */
export function snapshotInput(value: unknown): unknown {
  return copy(value, 0, new Set());
}

function copy(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidInputError("Input contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") {
    throw new InvalidInputError(`Input contains an unsupported ${typeof value} value`);
  }
  if (depth >= MAX_DEPTH) throw new InvalidInputError("Input is nested too deeply");
  if (seen.has(value)) throw new InvalidInputError("Input contains a circular reference");
  seen.add(value);

  let out: unknown;
  if (Array.isArray(value)) {
    const length = value.length;
    const arr: unknown[] = new Array(length);
    for (let i = 0; i < length; i++) {
      if (!Object.hasOwn(value, i)) throw new InvalidInputError("Input contains a sparse array");
      arr[i] = copy(value[i], depth + 1, seen);
    }
    out = Object.freeze(arr);
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new InvalidInputError("Input contains a non-plain object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new InvalidInputError("Input contains symbol keys");
    }
    const obj: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      // defineProperty, not assignment: a key named "__proto__" stays an own
      // data property instead of replacing the snapshot's prototype.
      Object.defineProperty(obj, key, {
        value: copy((value as Record<string, unknown>)[key], depth + 1, seen),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    out = Object.freeze(obj);
  }

  seen.delete(value);
  return out;
}
