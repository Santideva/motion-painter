/**
 * PersistenceHelper.js
 * Pure-function artifact persistence helper for Motion-Painter pipeline modules.
 *
 * Encapsulates TTL selection, pinType assignment, and the _persistAndPin call
 * contract so every pipeline stage (MotionDetector, DifferentialGeometry, and
 * all future stages) share identical lifecycle semantics without duplicating code.
 *
 * USAGE
 *   import { persist, persistMany, safeKey, TTL, PIN } from './PersistenceHelper.js';
 *
 *   const result = await persist(store, {
 *     type:    'curvature_field',
 *     data:    { kH, kG, k1, k2 },
 *     meta:    { narrowBandPx, method: 'rbf_fd', samplingContext },
 *     ttl:     TTL.PINNED,
 *     pinType: PIN.SOFT,
 *   });
 *   // result: { metaKey: string } | null
 *
 *   // Gating a debug artifact inline:
 *   await persist(store, { type: 'sdf_diagnostics', data, meta, skip: !flags.packingDebug });
 *
 *   // Extracting the key safely:
 *   const curveKey = safeKey(result);   // string | null
 *
 * STORE CONTRACT
 *   store.persistAndPin(type, data, meta, ttlMs, pinType) → Promise<{ metaKey: string }>
 *
 * The store parameter is passed explicitly on every call rather than held as
 * instance state so this module remains stateless and trivially testable.
 */

/* -------------------------------------------------------------------------- */
/*  TTL constants (ms)                                                         */
/* -------------------------------------------------------------------------- */

export const TTL = Object.freeze({
  /**
   * PINNED — long-lived artifacts needed by downstream stages across the full
   * reconstruction cycle. Matches ARTIFACT_PIN_TTL_MS in motion.worker.
   */
  PINNED: 5 * 60_000,         //  5 min

  /**
   * INTERMEDIATE — artifacts useful for debugging or optional downstream
   * consumption but not on the critical path. Matches INTERMEDIATE_TTL_MS.
   */
  INTERMEDIATE: 120_000,  // 2 min  — matches INTERMEDIATE_TTL_MS in motion.worker

  /**
   * DEBUG — short-lived diagnostic artifacts. Only persisted when the
   * relevant debug flag is enabled. Not expected downstream.
   */
  DEBUG: 30_000,               // 30 s
});

/* -------------------------------------------------------------------------- */
/*  Pin type constants                                                         */
/* -------------------------------------------------------------------------- */

export const PIN = Object.freeze({
  /**
   * SOFT — artifact is evictable under memory pressure. Use for all pipeline
   * artifacts that can be recomputed if evicted (the common case).
   */
  SOFT: 'soft',

  /**
   * HARD — artifact survives eviction. Reserve for small key-index or header
   * artifacts whose absence would break a downstream stage with no recovery path.
   */
  HARD: 'hard',
});

/* -------------------------------------------------------------------------- */
/*  persist(store, descriptor) → Promise<{ metaKey } | null>                  */
/* -------------------------------------------------------------------------- */

/**
 * persist(store, descriptor)
 *
 * Single-artifact persist with:
 *   - skip gating          (descriptor.skip = true → return null without touching storage)
 *   - createdAt injection  (always added to meta here — stores must NOT add it themselves)
 *   - required flag        (descriptor.required = true → throws instead of returning null on failure)
 *
 * @param {object} store
 * @param {object} descriptor
 * @param {string}  descriptor.type
 * @param {*}       descriptor.data
 * @param {object}  [descriptor.meta={}]
 * @param {number}  descriptor.ttl
 * @param {string}  [descriptor.pinType=PIN.SOFT]
 * @param {boolean} [descriptor.skip=false]
 * @param {boolean} [descriptor.required=false]   — throws on failure when true
 * @returns {Promise<{ok, metaKey}|null>}
 */
export async function persist(store, descriptor) {
  const {
    type,
    data,
    meta     = {},
    ttl,
    pinType  = PIN.SOFT,
    skip     = false,
    required = false
  } = descriptor;

  if (skip) return null;

  if (!store) {
    const msg = `[PersistenceHelper] persist: store is null for artifact '${type}'`;
    if (required) throw new Error(msg);
    console.warn(msg);
    return null;
  }

  try {
    // createdAt is always injected here — never by the store adapter.
    const enrichedMeta = { ...meta, createdAt: new Date().toISOString() };
    const result = await store.persistAndPin(type, data, enrichedMeta, ttl, pinType);

    if (!result) {
      const msg = `[PersistenceHelper] persist: persistAndPin returned null for '${type}'`;
      if (required) throw new Error(msg);
      console.warn(msg);
      return null;
    }

    return result;

  } catch (err) {
    if (required) throw err;   // propagate — caller must handle critical failures
    console.warn(`[PersistenceHelper] persist failed for '${type}':`, err.message);
    return null;
  }
}

/**
 * persistMany(store, descriptors)
 *
 * Sequential batch persist. Failures on non-required descriptors are
 * isolated (null result, console.warn). Failures on required descriptors
 * propagate — the caller receives the throw immediately.
 *
 * @param {object}   store
 * @param {object[]} descriptors  — same schema as persist() descriptor
 * @returns {Promise<Array<{ok, metaKey}|null>>}
 */
export async function persistMany(store, descriptors) {
  const results = [];
  for (const descriptor of descriptors) {
    results.push(await persist(store, descriptor));  // required throws propagate naturally
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*  safeKey(result) → string | null                                            */
/* -------------------------------------------------------------------------- */

/**
 * Extract metaKey from a persist result safely.
 * Eliminates the repetitive `result?.metaKey ?? null` idiom at every call site.
 *
 * @param {{ metaKey: string } | null | undefined} result
 * @returns {string | null}
 */
export function safeKey(result) {
  return (result && typeof result.metaKey === 'string') ? result.metaKey : null;
}

/* -------------------------------------------------------------------------- */
/*  Default export                                                             */
/* -------------------------------------------------------------------------- */

const PersistenceHelper = { persist, persistMany, safeKey, TTL, PIN };
export default PersistenceHelper;