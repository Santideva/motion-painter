// /src/js/core/hashFNV1a.js
//
// FNV-1a 32-bit hash — deterministic, dependency-free string hashing.
//
// Used by:
//   WorldFrameId.js  — computeStructureId(b0, b1, ends) → structureId
//   ViewManifold.js  — edge key generation
//
// Properties:
//   - Pure integer arithmetic, no platform entropy, no external deps
//   - Identical output across sessions, browsers, and devices for the same input
//   - Returns an 8-character lowercase hex string (zero-padded)
//   - 32-bit output: collision probability negligible for the expected
//     number of distinct topological structures per session (< 10,000)
//
// Algorithm (FNV-1a, 32-bit):
//   offset_basis = 2166136261  (0x811c9dc5)
//   prime        = 16777619    (0x01000193)
//   for each byte b in input:
//     hash = (hash XOR b) * prime   [mod 2³²]
//
// Reference: http://www.isthe.com/chongo/tech/comp/fnv/

/**
 * hashFNV1a
 *
 * Hashes a UTF-8 string using FNV-1a (32-bit) and returns a zero-padded
 * 8-character lowercase hex string.
 *
 * @param   {string} str — the string to hash
 * @returns {string}       8-character hex, e.g. "811c9dc5"
 *
 * @example
 * hashFNV1a('b0:1|b1:0|n:3|m:1,1,2')  // → deterministic 8-char hex
 * hashFNV1a('')                         // → '811c9dc5'  (offset basis)
 */
export function hashFNV1a(str) {
  // FNV-1a 32-bit constants
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME        = 0x01000193;

  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < str.length; i++) {
    // Encode character to UTF-16 code unit, then process each byte
    // For the ASCII subset used by structureId strings this is equivalent
    // to UTF-8. For non-ASCII characters we process both bytes of the
    // UTF-16 code unit to maintain determinism.
    const code = str.charCodeAt(i);

    // Low byte
    hash ^= (code & 0xff);
    // Math.imul gives correct 32-bit integer multiplication without overflow
    hash  = Math.imul(hash, FNV_PRIME);

    // High byte (zero for ASCII — included for correctness with non-ASCII)
    const high = (code >>> 8) & 0xff;
    if (high !== 0) {
      hash ^= high;
      hash  = Math.imul(hash, FNV_PRIME);
    }
  }

  // Convert to unsigned 32-bit then format as 8-character hex
  return ((hash >>> 0).toString(16)).padStart(8, '0');
}

export default hashFNV1a;