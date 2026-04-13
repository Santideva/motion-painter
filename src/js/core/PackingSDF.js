/**
 * PackingSDF.js — Stage 2: Geometric Domain Representation
 *
 * Bridges pixel-domain outputs (depth_map, normal_map from Stage 0;
 * directness_map, penumbra_width_map from Stage 1) to geometric-domain
 * representation via Signed Distance Function.
 *
 * Three core responsibilities:
 *   1. Compute signed SDF from depth/normal with GPT-derived σ² filter
 *   2. Extract adaptive narrow band (localises all downstream computation)
 *   3. Place disk seeds via MultiSampler tri-blend (Wallis/Random/Vogel)
 *      driven by SDF-gradient variance and modal-label-adaptive weights
 *
 * GPT Framework integration:
 *   - σ²_geometric (scalene variance) as second discriminant for depth
 *     discontinuity detection — filters quantization noise from real edges
 *   - MedStress continuous signing-confidence score replaces binary normal flip
 *   - Latent heat bandwidth validates narrow band lower bound
 *
 * MultiSampler integration:
 *   - SDF gradient magnitude field replaces pixel-luminance variance
 *   - Modal-label-adaptive weight presets (DIRECT / PENUMBRA / UMBRA)
 *   - Vogel spiral covers UMBRA uniformly without pretending depth is reliable
 *
 * Downstream consumers:
 *   Stage 3 — DifferentialGeometryProcessor: signed_sdf, narrow_band_mask
 *   Stage 4A — TopologicalAnalysis:           narrow_band_mask, signed_sdf
 *   Stage 4B — ConstrainedMinimizer:          disk_seeds, density_map
 *   Stage 5  — AmbiAnamorph:                  density_map
 *   Stage 8  — PascalSterling:                narrow_band_mask (split guide),
 *                                             density_map (compression field)
 *
 * @module PackingSDF
 */

import MultiSampler from '../sampler/MultiSampler.js';

// ---------------------------------------------------------------------------
// GPT FRAMEWORK CONSTANTS
// ---------------------------------------------------------------------------

/**
 * Euclidean Phase Point packing density — 2D hexagonal close-packing.
 * Treated as the "melting point" between ultrametric (Δ=1) and Riemannian
 * (Δ variable) phases. Used to normalise scalene variance σ².
 */
const GPT_DELTA_2D = Math.PI / (2 * Math.sqrt(3)); // ≈ 0.9069

/**
 * 3D FCC packing limit — target for Stage 4B manifold closure.
 * Seeds must cover at density consistent with Δ₃ ≈ 0.7405.
 */
const GPT_DELTA_3D = Math.PI / (3 * Math.sqrt(2)); // ≈ 0.7405

/**
 * Structural √12 factor from hexagonal lattice (6 equilateral triangles).
 * Used in scalene variance normalisation.
 */
const GPT_SQRT12 = Math.sqrt(12);

/**
 * Euclidean median ratio (2D: 2∶1, 3D: 3∶1).
 * MedStress = |dist/medDist − GPT_MED_RATIO_2D|
 */
const GPT_MED_RATIO_2D = 2.0;

/**
 * Fine-structure-analogue: fractional packing gap at Euclidean phase.
 * (1 − GPT_DELTA_2D) ≈ 0.093.  Controls latent heat bandwidth.
 */
const GPT_ALPHA = 1 - GPT_DELTA_2D; // ≈ 0.0931

// ---------------------------------------------------------------------------
// MODAL LABEL CONSTANTS  (mirror Stage 1 conventions)
// ---------------------------------------------------------------------------
const MODAL = { DIRECT: 2, PENUMBRA: 1, UMBRA: 0 };

// ---------------------------------------------------------------------------
// MULTISAMPLER WEIGHT PRESETS  (modal-label adaptive)
// ---------------------------------------------------------------------------
const SAMPLER_WEIGHTS = {
    [MODAL.DIRECT]:   { wallis: 0.60, random: 0.20, vogel: 0.20 },
    [MODAL.PENUMBRA]: { wallis: 0.35, random: 0.30, vogel: 0.35 },
    [MODAL.UMBRA]:    { wallis: 0.10, random: 0.20, vogel: 0.70 },
};

// ---------------------------------------------------------------------------
// DEFAULT CONFIGURATION
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
    // ── SDF / EDT ──────────────────────────────────────────────────────────
    /** Min absolute depth difference (normalised [0,1]) to seed a zero-level
     *  set candidate.  Adaptively loosened in penumbra regions. */
    depthDiscontinuityThreshold: 0.04,

    /** Penumbra multiplier: in penumbra pixels the threshold is multiplied by
     *  this factor (>1 = looser, acknowledging genuine surface transitions). */
    penumbraThresholdMult: 2.5,

    /** GPT σ² gate: candidate only promoted to zero-level set if its local
     *  scalene variance exceeds this fraction of the per-frame σ² max. */
    scaleneVarianceGate: 0.25,

    /** Normal-back-face dot-product threshold for initial interior labelling. */
    normalBackFaceDot: -0.3,

    /** MedStress threshold above which signing confidence is "suspect" and the
     *  normal-guided correction pass fires. */
    medStressThreshold: 0.8,

    // ── Narrow Band ────────────────────────────────────────────────────────
    /** Base narrow band half-width as fraction of max SDF magnitude. */
    bandBase: 0.03,

    /** Per-pixel band scale: bandWidth(P) = bandBase + bandScale×widthMap(P) */
    bandScale: 3.0,

    /** Smooth fall-off exponent for the float narrow band mask
     *  (1 = linear, 2 = quadratic attenuation toward band edge). */
    bandFalloffExp: 2.0,

    // ── UMBRA policy ───────────────────────────────────────────────────────
    /** 'exclude' | 'half-weight' | 'include'
     *  Controls whether UMBRA-region SDF values enter downstream computation. */
    umbraPolicy: 'half-weight',

    // ── Sampling / Seeds ───────────────────────────────────────────────────
    /** Random seed for MultiSampler (deterministic reproduction). */
    samplerSeed: 0xF1E2D3C4,

    /** Min allowed distance between seed centres in normalised coords [0,1]. */
    seedRMin: 0.01,

    /** Max allowed distance (used when density = 0). */
    seedRMax: 0.08,

    /** Density smoothing kernel radius in pixels before feeding MultiSampler. */
    densitySmoothRadius: 4,

    /** MultiSampler time budget per region in ms. */
    samplerTimeBudgetMs: 80,

    /** MultiSampler max seed points (clamped by narrow band area). */
    samplerMaxPoints: 2048,

    /** MultiSampler min seed points. */
    samplerMinPoints: 64,

    // ── Miscellaneous ──────────────────────────────────────────────────────
    enableDebug: false,
};

// ===========================================================================
//  PackingSDF
// ===========================================================================

export class PackingSDF {
    /**
     * @param {Object} [options] — Override any DEFAULT_CONFIG key.
     */
    constructor(options = {}) {
        this._cfg = { ...DEFAULT_CONFIG, ...options };
        this._sampler = null; // Lazy init — needs width/height to tune density
        this._telemetry = {};
    }

    // =========================================================================
    //  PRIMARY ENTRY POINT
    // =========================================================================

    /**
     * Main computation entry.
     *
     * @param {Float32Array} depthMap       — normalised [0,1], row-major
     * @param {Float32Array} normalMap      — interleaved [nx,ny,nz] per pixel
     * @param {Float32Array} directnessField — f_map from Stage 1, [0,1] per px
     * @param {Float32Array} penumbraField  — penumbra_width_map, pixels [0,∞)
     * @param {Object}       options
     * @param {number}       options.width
     * @param {number}       options.height
     * @param {Object}       [options.samplingContext]  — from Stage 0 container
     * @param {Float32Array} [options.modalLabels]      — DIRECT/PENUMBRA/UMBRA
     * @param {Float32Array} [options.fresnelDensity]   — optional Fresnel field
     * @returns {Promise<Object>} PackingSDF result artifact
     */
    async compute(depthMap, normalMap, directnessField, penumbraField, options = {}) {
        const t0 = performance.now();
        const { width, height, samplingContext = {}, modalLabels = null,
                fresnelDensity = null } = options;

        if (!width || !height) throw new Error('PackingSDF.compute: width/height required');
        const n = width * height;

        this._log('PackingSDF.compute start', { width, height });

        // ── 1. GPT σ² geometric scalene variance map ──────────────────────
        const t1 = performance.now();
        const scaleneVariance = this._computeScaleneVariance(depthMap, width, height);
        this._telemetry.scaleneVarianceMs = performance.now() - t1;

        // ── 2. Zero-level-set candidates (GPT σ²-gated depth discontinuity) ─
        const t2 = performance.now();
        const surfaceMask = this._detectZeroLevelSet(
            depthMap, penumbraField, scaleneVariance, width, height);
        this._telemetry.zeroLevelSetMs = performance.now() - t2;

        // ── 3. EDT — positive and negative Euclidean distance transforms ──
        const t3 = performance.now();
        const posEDT = this._computeEDT(surfaceMask, width, height, true);
        const negEDT = this._computeEDT(surfaceMask, width, height, false);
        this._telemetry.edtMs = performance.now() - t3;

        // ── 4. Combine into raw signed SDF ────────────────────────────────
        const t4 = performance.now();
        const signedSdf = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            signedSdf[i] = posEDT[i] - negEDT[i];
        }
        this._telemetry.combineMs = performance.now() - t4;

        // ── 5. Normal-guided signing correction with MedStress ────────────
        const t5 = performance.now();
        const medStressMap = this._applyNormalSigningCorrection(
            signedSdf, normalMap, samplingContext, width, height);
        this._telemetry.signingMs = performance.now() - t5;

        // ── 6. UMBRA policy attenuation ───────────────────────────────────
        if (modalLabels) {
            this._applyUmbraPolicy(signedSdf, modalLabels, this._cfg.umbraPolicy);
        }

        // ── 7. Adaptive narrow band mask ──────────────────────────────────
        const t7 = performance.now();
        const { narrowBandMask, sdfMin, sdfMax } =
            this._computeNarrowBand(signedSdf, penumbraField, width, height);
        this._telemetry.narrowBandMs = performance.now() - t7;

        // ── 8. Density field (smoothed directness × fresnel) ──────────────
        const t8 = performance.now();
        const densityMap = this._buildDensityMap(
            directnessField, signedSdf, fresnelDensity, narrowBandMask,
            width, height);
        this._telemetry.densityMs = performance.now() - t8;

        // ── 9. Disk seeds via MultiSampler tri-blend ──────────────────────
        const t9 = performance.now();
        const diskSeeds = await this._placeDiskSeeds(
            signedSdf, densityMap, narrowBandMask, depthMap, normalMap,
            directnessField, modalLabels, width, height);
        this._telemetry.seedingMs = performance.now() - t9;

        this._telemetry.totalMs = performance.now() - t0;
        this._log('PackingSDF.compute done', this._telemetry);

        return {
            // ── Primary geometric outputs ──────────────────────────────────
            signedSdf,          // Float32Array — zero-level set = surface
            narrowBandMask,     // Float32Array — smooth [0,1] near-surface mask
            diskSeeds,          // Array<DiskSeed>
            densityMap,         // Float32Array — smooth density field

            // ── Diagnostic / derivative fields ────────────────────────────
            scaleneVariance,    // Float32Array — GPT σ² per pixel
            medStressMap,       // Float32Array — signing confidence (0=ok,1=suspect)
            surfaceMask,        // Uint8Array   — zero-level set binary mask

            // ── Metadata ──────────────────────────────────────────────────
            meta: {
                width, height,
                sdfRange: [sdfMin, sdfMax],
                seedCount: diskSeeds.length,
                narrowBandPixels: narrowBandMask.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0),
                umbraPolicy: this._cfg.umbraPolicy,
                samplingContext,
                telemetry: { ...this._telemetry },
            },
        };
    }

    // =========================================================================
    //  GPT σ² SCALENE VARIANCE  (geometric temperature)
    // =========================================================================

    /**
     * For each pixel P, forms the triangle (P, right-neighbour, bottom-neighbour)
     * in depth-augmented image space and computes its scalene deviation σ².
     *
     * A near-equilateral triangle → σ² ≈ 0 (quantization noise, smooth surface).
     * A highly scalene triangle → σ² large (genuine depth discontinuity).
     *
     * σ²(P) = Var({ |AB|, |BC|, |CA| }) / (mean({ |AB|, |BC|, |CA| })² + ε)
     *
     * where A=P, B=P+right, C=P+down in (x, y, depth×scale) space.
     *
     * @param {Float32Array} depthMap
     * @param {number} width
     * @param {number} height
     * @returns {Float32Array} scaleneVariance — values in [0, ∞), normalised to [0,1]
     */
    _computeScaleneVariance(depthMap, width, height) {
        const n = width * height;
        const variance = new Float32Array(n);
        const depthScale = GPT_SQRT12; // Amplify depth axis relative to pixel-plane

        let maxVar = 0;

        for (let y = 0; y < height - 1; y++) {
            for (let x = 0; x < width - 1; x++) {
                const i = y * width + x;
                const iR = i + 1;
                const iD = i + width;

                // Triangle vertices in (x, y, z) — depth scaled by √12
                const ax = x,     ay = y,     az = depthMap[i]  * depthScale;
                const bx = x + 1, by = y,     bz = depthMap[iR] * depthScale;
                const cx = x,     cy = y + 1, cz = depthMap[iD] * depthScale;

                const ab = Math.sqrt((bx-ax)**2 + (by-ay)**2 + (bz-az)**2);
                const bc = Math.sqrt((cx-bx)**2 + (cy-by)**2 + (cz-bz)**2);
                const ca = Math.sqrt((ax-cx)**2 + (ay-cy)**2 + (az-cz)**2);

                const mean = (ab + bc + ca) / 3;
                const eps  = 1e-8;
                const varVal = ((ab-mean)**2 + (bc-mean)**2 + (ca-mean)**2) /
                               (3 * (mean * mean + eps));

                variance[i] = varVal;
                if (varVal > maxVar) maxVar = varVal;
            }
        }

        // Normalise to [0,1] for gating
        if (maxVar > 0) {
            for (let i = 0; i < n; i++) variance[i] /= maxVar;
        }

        return variance;
    }

    // =========================================================================
    //  ZERO-LEVEL SET DETECTION
    // =========================================================================

    /**
     * Identifies pixels that become the zero-level set for the EDT.
     * Combines:
     *   - Large depth gradient between 4-neighbours (primary signal)
     *   - GPT σ² gate (secondary: rejects quantization artifacts)
     *
     * In penumbra regions the depth threshold is loosened by
     * `penumbraThresholdMult` because penumbra transitions are genuine surface
     * geometry.
     *
     * @returns {Uint8Array} surfaceMask — 1 at zero-level set pixels
     */
    _detectZeroLevelSet(depthMap, penumbraField, scaleneVariance, width, height) {
        const n = width * height;
        const mask = new Uint8Array(n);
        const { depthDiscontinuityThreshold, penumbraThresholdMult,
                scaleneVarianceGate } = this._cfg;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                const d = depthMap[i];

                // Adaptive threshold: penumbra pixels get looser gate
                const penW = penumbraField ? penumbraField[i] : 0;
                const thresh = depthDiscontinuityThreshold *
                    (penW > 0 ? penumbraThresholdMult : 1.0);

                // Sample 4-neighbours
                let maxDiff = 0;
                if (x > 0)          maxDiff = Math.max(maxDiff, Math.abs(d - depthMap[i - 1]));
                if (x < width - 1)  maxDiff = Math.max(maxDiff, Math.abs(d - depthMap[i + 1]));
                if (y > 0)          maxDiff = Math.max(maxDiff, Math.abs(d - depthMap[i - width]));
                if (y < height - 1) maxDiff = Math.max(maxDiff, Math.abs(d - depthMap[i + width]));

                // GPT σ² gate — require high scalene variance to admit as true edge
                const sigma2 = scaleneVariance[i];
                const passesGPT = sigma2 >= scaleneVarianceGate;

                if (maxDiff >= thresh && passesGPT) {
                    mask[i] = 1;
                }
            }
        }

        return mask;
    }

    // =========================================================================
    //  EUCLIDEAN DISTANCE TRANSFORM  (Felzenszwalb-Huttenlocher, O(n))
    // =========================================================================

    /**
     * Computes the exact EDT via two separable 1-D passes.
     *
     * @param {Uint8Array} surfaceMask  — 1 = seed pixel (zero-level set)
     * @param {number}     width
     * @param {number}     height
     * @param {boolean}    fromForeground — true: distance from non-seed pixels
     *                                      to nearest seed (positive EDT).
     *                                     false: distance from seed pixels to
     *                                      nearest non-seed (negative EDT).
     * @returns {Float32Array} EDT field (distances in pixel units)
     */
    _computeEDT(surfaceMask, width, height, fromForeground) {
        const n = width * height;
        const INF = 1e9;
        const f = new Float32Array(n);
        const d = new Float32Array(n);

        // Initialise: foreground pixels get 0 (they are "sources"), others INF
        for (let i = 0; i < n; i++) {
            const isSeed = fromForeground ? (surfaceMask[i] === 1) : (surfaceMask[i] === 0);
            f[i] = isSeed ? 0 : INF;
        }

        // Horizontal pass (1-D EDT along each row)
        const tmp = new Float32Array(Math.max(width, height));
        const v   = new Int32Array(Math.max(width, height));
        const z   = new Float32Array(Math.max(width, height) + 1);

        for (let y = 0; y < height; y++) {
            const row = y * width;
            this._edt1D(f, tmp, v, z, row, 1, width);
            for (let x = 0; x < width; x++) f[row + x] = tmp[x];
        }

        // Transform: square the horizontal distances before vertical pass
        for (let i = 0; i < n; i++) {
            f[i] = f[i] * f[i]; // Will be combined with vertical distance²
        }

        // Vertical pass
        for (let x = 0; x < width; x++) {
            this._edt1D(f, tmp, v, z, x, width, height);
            for (let y = 0; y < height; y++) d[y * width + x] = Math.sqrt(tmp[y]);
        }

        return d;
    }

    /**
     * 1-D EDT pass (Felzenszwalb-Huttenlocher § 2).
     * Operates on a strided slice of `f`, writes result into `d`.
     *
     * @param {Float32Array} f      — input (squared distances from horiz pass, or init)
     * @param {Float32Array} d      — output buffer (length ≥ length)
     * @param {Int32Array}   v      — work buffer (parabola centres)
     * @param {Float32Array} z      — work buffer (parabola intersection x-coords)
     * @param {number}       offset — starting index in f / d
     * @param {number}       stride — step between elements
     * @param {number}       length — number of elements
     */
    _edt1D(f, d, v, z, offset, stride, length) {
        let k = 0;
        v[0] = 0;
        z[0] = -1e30;
        z[1] =  1e30;

        for (let q = 1; q < length; q++) {
            const fq = f[offset + q * stride];
            let s;
            // Merge parabola centred at q with envelope
            do {
                const vk = v[k];
                const fvk = f[offset + vk * stride];
                s = ((fq + q * q) - (fvk + vk * vk)) / (2 * q - 2 * vk);
                if (s <= z[k]) k--;
            } while (k >= 0 && s <= z[k]);

            k++;
            v[k]     = q;
            z[k]     = s;
            z[k + 1] = 1e30;
        }

        k = 0;
        for (let q = 0; q < length; q++) {
            while (z[k + 1] < q) k++;
            const vk = v[k];
            const dx = q - vk;
            d[q] = dx * dx + f[offset + vk * stride];
        }
    }

    // =========================================================================
    //  NORMAL-GUIDED SIGNING CORRECTION WITH GPT MED-STRESS
    // =========================================================================

    /**
     * Checks every pixel against two criteria:
     *   1. Normal dot product with camera direction (back-facing → should be negative)
     *   2. GPT MedStress score (local SDF inconsistency → signing suspect)
     *
     * Where both criteria agree on a flip and the current sign conflicts, the
     * sign is corrected. Returns the MedStress map as a diagnostic artifact.
     *
     * @returns {Float32Array} medStressMap — [0,1], higher = signing more suspect
     */
    _applyNormalSigningCorrection(signedSdf, normalMap, samplingContext, width, height) {
        const n = width * height;
        const medStressMap = new Float32Array(n);
        const { normalBackFaceDot, medStressThreshold } = this._cfg;

        // Orientation convention from samplingContext (CCW vs CW flips dot sign)
        const orientSign = (samplingContext.orientationConvention === 'CW') ? -1 : 1;

        // Precompute local median of |SDF| in a 3×3 neighbourhood
        // Used for MedStress = |sdf(P) / medNeighbour - 2|
        const absSdf = new Float32Array(n);
        for (let i = 0; i < n; i++) absSdf[i] = Math.abs(signedSdf[i]);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i   = y * width + x;
                const ni  = i * 3;
                const nz  = normalMap[ni + 2]; // Camera-space Z component
                const sdf = signedSdf[i];
                const asd = absSdf[i];

                // ── GPT MedStress ────────────────────────────────────────
                // Collect 3×3 neighbourhood |SDF| values
                const neighbours = [];
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const ny_ = y + dy, nx_ = x + dx;
                        if (ny_ >= 0 && ny_ < height && nx_ >= 0 && nx_ < width) {
                            neighbours.push(absSdf[ny_ * width + nx_]);
                        }
                    }
                }
                neighbours.sort((a, b) => a - b);
                const medNeighbour = neighbours[Math.floor(neighbours.length / 2)] + 1e-8;

                const medStress = Math.abs(asd / medNeighbour - GPT_MED_RATIO_2D) /
                                  GPT_MED_RATIO_2D; // Normalise to [0,∞)
                medStressMap[i] = Math.min(1, medStress);

                // ── Normal-guided correction ─────────────────────────────
                // Back-facing normals (nz < threshold) should be negative SDF
                const dotWithCamera = nz * orientSign;
                const isBackFacing = dotWithCamera < normalBackFaceDot;
                const signingIsSuspect = medStressMap[i] > medStressThreshold;

                if (isBackFacing && signingIsSuspect && sdf > 0) {
                    signedSdf[i] = -asd;
                } else if (!isBackFacing && signingIsSuspect && sdf < 0) {
                    // Front-facing but negative — less common, apply conservatively
                    if (dotWithCamera > 0.5) signedSdf[i] = asd;
                }
            }
        }

        return medStressMap;
    }

    // =========================================================================
    //  UMBRA POLICY
    // =========================================================================

    /**
     * Applies the configured UMBRA policy to attenuate SDF values in shadow
     * regions where depth estimates are unreliable.
     *
     * 'exclude'     — SDF set to NaN (downstream stages skip NaN pixels)
     * 'half-weight' — SDF multiplied by 0.5
     * 'include'     — no change
     */
    _applyUmbraPolicy(signedSdf, modalLabels, policy) {
        if (policy === 'include') return;
        const n = signedSdf.length;

        for (let i = 0; i < n; i++) {
            if (modalLabels[i] === MODAL.UMBRA) {
                if (policy === 'exclude') {
                    signedSdf[i] = NaN;
                } else { // 'half-weight'
                    signedSdf[i] *= 0.5;
                }
            }
        }
    }

    // =========================================================================
    //  ADAPTIVE NARROW BAND
    // =========================================================================

    /**
     * Computes the smooth narrow band mask.
     *
     * bandWidth(P) = bandBase + bandScale × penumbraWidth(P)
     * narrowBandMask(P) = smoothstep(bandWidth, 0, |sdf(P)|)^falloffExp
     *
     * The GPT "latent heat" lower bound is enforced:
     *   bandBase ≥ GPT_ALPHA × (sdfMax - sdfMin)
     * ensuring at least the frictional residue of the phase transition is
     * captured in the narrow band.
     *
     * @returns {{ narrowBandMask: Float32Array, sdfMin: number, sdfMax: number }}
     */
    _computeNarrowBand(signedSdf, penumbraField, width, height) {
        const n = width * height;

        // Compute SDF range (ignoring NaN)
        let sdfMin = Infinity, sdfMax = -Infinity;
        for (let i = 0; i < n; i++) {
            const v = signedSdf[i];
            if (!isNaN(v)) { if (v < sdfMin) sdfMin = v; if (v > sdfMax) sdfMax = v; }
        }
        const sdfRange = sdfMax - sdfMin || 1;

        // GPT latent heat lower bound on band base
        const latentHeatBandBase = GPT_ALPHA * sdfRange;
        const bandBase = Math.max(this._cfg.bandBase * sdfRange, latentHeatBandBase);

        const mask = new Float32Array(n);
        const { bandScale, bandFalloffExp } = this._cfg;

        for (let i = 0; i < n; i++) {
            const v = signedSdf[i];
            if (isNaN(v)) { mask[i] = 0; continue; }

            const penW   = penumbraField ? penumbraField[i] : 0;
            const bw     = bandBase + bandScale * penW;
            const absV   = Math.abs(v);

            if (absV >= bw) {
                mask[i] = 0;
            } else {
                // Smooth fall-off: 1 at surface, 0 at band edge
                const t = 1 - absV / bw;
                mask[i] = Math.pow(t, bandFalloffExp);
            }
        }

        return { narrowBandMask: mask, sdfMin, sdfMax };
    }

    // =========================================================================
    //  DENSITY MAP
    // =========================================================================

    /**
     * Builds the smooth density field for MultiSampler and Stage 4B / Stage 5.
     *
     * density(P) = smoothstep(0.1, 0.9, |∇f(P)|) × fresnelDensity(P) × nbMask(P)
     *
     * Both factors are smoothed before multiplication to prevent hard seeding
     * voids at modal-label boundaries.  GPT smoothstep maps the directness
     * gradient — how fast the field transitions between DIRECT/PENUMBRA/UMBRA —
     * into a continuous density that concentrates seeds near phase boundaries.
     *
     * @returns {Float32Array} densityMap — values in [0,1]
     */
    _buildDensityMap(directnessField, signedSdf, fresnelDensity,
                     narrowBandMask, width, height) {
        const n = width * height;
        const density = new Float32Array(n);

        // ── Directness gradient magnitude ─────────────────────────────────
        const gradMag = new Float32Array(n);
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                const gx = directnessField[i + 1] - directnessField[i - 1];
                const gy = directnessField[i + width] - directnessField[i - width];
                gradMag[i] = Math.sqrt(gx * gx + gy * gy) * 0.5;
            }
        }

        // Smooth gradMag with a box blur (radius = densitySmoothRadius)
        const smoothGrad = this._boxBlur(gradMag, width, height, this._cfg.densitySmoothRadius);

        // ── SDF gradient magnitude (surface proximity signal for Wallis) ──
        const sdfGrad = this._computeSdfGradientMagnitude(signedSdf, width, height);
        const smoothSdfGrad = this._boxBlur(sdfGrad, width, height, 2);

        // ── Compose density ───────────────────────────────────────────────
        for (let i = 0; i < n; i++) {
            const nb = narrowBandMask[i];
            if (nb === 0) { density[i] = 0; continue; }

            const ss = this._smoothstep(0.1, 0.9, smoothGrad[i]);
            const fr = fresnelDensity ? fresnelDensity[i] : 1.0;

            // Combine: directness gradient (where is the phase boundary?) ×
            //          fresnel density (where is reflectance geometry active?) ×
            //          narrow band weight
            density[i] = Math.min(1, ss * fr) * nb;
        }

        return density;
    }

    // =========================================================================
    //  MULTISAMPLER-BASED DISK SEED PLACEMENT
    // =========================================================================

    /**
     * Places disk seeds using MultiSampler's tri-blend
     * (Wallis / Random / Vogel) with:
     *   - SDF gradient magnitude substituting for pixel-luminance variance
     *     (so Wallis concentrates seeds near the zero-level set)
     *   - Modal-label-adaptive weight presets
     *   - Vogel spiral filling UMBRA coverage uniformly
     *
     * Seeds are partitioned by modal region and each partition is sampled with
     * its own preset, then merged.
     *
     * @returns {Array<DiskSeed>}
     */
    async _placeDiskSeeds(signedSdf, densityMap, narrowBandMask, depthMap,
                          normalMap, directnessField, modalLabels, width, height) {
        const seeds = [];
        const sdfGradMag = this._computeSdfGradientMagnitude(signedSdf, width, height);

        // Partition narrow-band pixels by modal label
        const partitions = {
            [MODAL.DIRECT]:   [],
            [MODAL.PENUMBRA]: [],
            [MODAL.UMBRA]:    [],
        };

        for (let i = 0; i < width * height; i++) {
            if (narrowBandMask[i] < 0.1) continue;
            const label = modalLabels ? modalLabels[i] : MODAL.DIRECT;
            partitions[label].push(i);
        }

        // Sample each partition with its adapted weight preset
        for (const [labelStr, pixels] of Object.entries(partitions)) {
            const label = Number(labelStr);
            if (pixels.length === 0) continue;

            const weights = SAMPLER_WEIGHTS[label];
            const partitionSeeds = await this._samplePartition(
                pixels, weights, sdfGradMag, densityMap, depthMap, normalMap,
                directnessField, label, width, height);

            seeds.push(...partitionSeeds);
        }

        return seeds;
    }

    /**
     * Samples one modal partition via MultiSampler.
     * The partition pixels are composited into a synthetic single-channel
     * "image" (packed as Float32 RGBA-equivalent via the sdfGradMag field),
     * then sampled via the configured tri-blend.
     *
     * Placed samples are projected back to full-image coordinates and
     * packaged as DiskSeed objects.
     *
     * @returns {Array<DiskSeed>}
     */
    async _samplePartition(pixels, weights, sdfGradMag, densityMap,
                           depthMap, normalMap, directnessField,
                           modalLabel, width, height) {
        if (pixels.length === 0) return [];

        const cfg = this._cfg;

        // Build bounding box for this partition so we can create a compact
        // sub-image for MultiSampler
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const i of pixels) {
            const x = i % width, y = Math.floor(i / width);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        // Pack SDF gradient magnitude as RGBA (R=G=B=value, A=255) so
        // MultiSampler's grayscale extraction is consistent
        const imgData = new Uint8ClampedArray(bw * bh * 4);
        const pixelSet = new Uint8Array(bw * bh); // Which sub-pixels are in partition

        for (const i of pixels) {
            const x = i % width, y = Math.floor(i / width);
            const lx = x - minX, ly = y - minY;
            const li = ly * bw + lx;
            const val = Math.min(255, Math.floor(sdfGradMag[i] * 255));
            imgData[li * 4]     = val;
            imgData[li * 4 + 1] = val;
            imgData[li * 4 + 2] = val;
            imgData[li * 4 + 3] = 255;
            pixelSet[li] = 1;
        }

        // Target point count proportional to partition area × density
        const totalDensity = pixels.reduce((s, i) => s + densityMap[i], 0);
        const maxSeeds = Math.floor(
            cfg.samplerMaxPoints * (pixels.length / (width * height)));
        const targetSeeds = Math.max(cfg.samplerMinPoints,
            Math.min(maxSeeds, Math.floor(totalDensity * 20)));

        // Instantiate / reconfigure sampler
        if (!this._sampler) {
            this._sampler = new MultiSampler({
                seed: cfg.samplerSeed,
                timeBudgetMs: cfg.samplerTimeBudgetMs,
                maxSamplePoints: cfg.samplerMaxPoints,
                minSamplePoints: cfg.samplerMinPoints,
                enableAdaptiveBlending: true,
                enableDebugOutput: cfg.enableDebug,
            });
        }

        this._sampler.updateConfig({
            wallis: weights.wallis,
            random: weights.random,
            vogel:  weights.vogel,
            maxSamplePoints: targetSeeds,
        });

        // Build normalised input object (bypasses Blob/ImageBitmap path)
        const normalizedInput = {
            width: bw,
            height: bh,
            data: imgData,
            type: 'Normalized',
        };

        const manifest = await this._sampler.sample(normalizedInput, {
            temporalMode: 'single',
        });

        if (!manifest || manifest.cancelled || !manifest.samplePoints) return [];

        // Poisson-style deduplication: reject seeds that violate min-distance
        // (MultiSampler's tolerance-based dedupe applies within the sampler;
        //  here we apply a spatial guard consistent with densityMap's r_min)
        const placedSeeds = [];
        const placedNorm  = [];

        for (const pt of manifest.samplePoints) {
            // Map back to full-image coords
            const fullX = Math.round(pt.x + minX);
            const fullY = Math.round(pt.y + minY);
            if (fullX < 0 || fullX >= width || fullY < 0 || fullY >= height) continue;

            const fi = fullY * width + fullX;
            if (pixelSet[(fullY - minY) * bw + (fullX - minX)] === 0) continue;

            const den = densityMap[fi];
            const rMin = cfg.seedRMin + (cfg.seedRMax - cfg.seedRMin) * (1 - den);

            // Check spatial guard against already-placed seeds
            let tooClose = false;
            const xn = pt.xNorm, yn = pt.yNorm;
            for (const [pxn, pyn] of placedNorm) {
                const dx = xn - pxn, dy = yn - pyn;
                if (Math.sqrt(dx*dx + dy*dy) < rMin) { tooClose = true; break; }
            }
            if (tooClose) continue;

            placedNorm.push([xn, yn]);

            // Build DiskSeed
            const ni = fi * 3;
            placedSeeds.push({
                imageXY:    [fullX, fullY],
                xNorm:      fullX / width,
                yNorm:      fullY / height,
                worldXYZ:   null, // Populated by Stage 4B from depthMap + intrinsics
                normal:     [
                    normalMap[ni],
                    normalMap[ni + 1],
                    normalMap[ni + 2],
                ],
                radius:     rMin,
                sdf:        0, // Will be computed from signedSdf by caller if needed
                depth:      depthMap[fi],
                directness: directnessField[fi],
                modalLabel,
                density:    den,
                samplerWeight: pt.weight,
                samplerSource: pt.source,
            });
        }

        return placedSeeds;
    }

    // =========================================================================
    //  PUBLIC SDF UTILITIES  (consumed by Stage 3, Stage 4B)
    // =========================================================================

    /**
     * Compute SDF gradient field (gx, gy) and magnitude.
     * Stage 3 differentiates the SDF rather than raw depth — this is the
     * primary input to its differential operators.
     *
     * @param {Float32Array} sdf
     * @param {number} width
     * @param {number} height
     * @param {number} [resolution=1] — physical pixel size (for unit correction)
     * @returns {{ gx: Float32Array, gy: Float32Array, magnitude: Float32Array }}
     */
    computeSdfGradient(sdf, width, height, resolution = 1) {
        const n = width * height;
        const gx  = new Float32Array(n);
        const gy  = new Float32Array(n);
        const mag = new Float32Array(n);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                let dx = 0, dy = 0;

                if (x > 0 && x < width - 1) {
                    dx = (this._sdfSafe(sdf, i + 1) - this._sdfSafe(sdf, i - 1)) / (2 * resolution);
                } else if (x === 0) {
                    dx = (this._sdfSafe(sdf, i + 1) - this._sdfSafe(sdf, i)) / resolution;
                } else {
                    dx = (this._sdfSafe(sdf, i)     - this._sdfSafe(sdf, i - 1)) / resolution;
                }

                if (y > 0 && y < height - 1) {
                    dy = (this._sdfSafe(sdf, i + width) - this._sdfSafe(sdf, i - width)) / (2 * resolution);
                } else if (y === 0) {
                    dy = (this._sdfSafe(sdf, i + width) - this._sdfSafe(sdf, i)) / resolution;
                } else {
                    dy = (this._sdfSafe(sdf, i)         - this._sdfSafe(sdf, i - width)) / resolution;
                }

                gx[i]  = dx;
                gy[i]  = dy;
                mag[i] = Math.sqrt(dx * dx + dy * dy);
            }
        }

        return { gx, gy, magnitude: mag };
    }

    /**
     * Compute mean curvature of SDF level sets at each pixel.
     * κ = div(∇SDF / |∇SDF|)
     *
     * Provides mean curvature of the implicit surface at each pixel — the
     * same quantity Stage 4B's Minimizer compares against the constraint
     * surface.  Computing it here avoids redundant recomputation in Stage 3.
     *
     * @param {Float32Array} sdf
     * @param {number} width
     * @param {number} height
     * @param {number} [resolution=1]
     * @returns {Float32Array} curvature κ (positive = convex, negative = concave)
     */
    computeSdfCurvature(sdf, width, height, resolution = 1) {
        const { gx, gy, magnitude } = this.computeSdfGradient(sdf, width, height, resolution);
        const n = width * height;
        const kappa = new Float32Array(n);
        const eps   = 1e-8;

        // Normalised gradient components
        const nx_ = new Float32Array(n);
        const ny_ = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const m = magnitude[i] + eps;
            nx_[i] = gx[i] / m;
            ny_[i] = gy[i] / m;
        }

        // Divergence of normalised gradient
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                const dnx_dx = (nx_[i + 1]     - nx_[i - 1])     / (2 * resolution);
                const dny_dy = (ny_[i + width]  - ny_[i - width]) / (2 * resolution);
                kappa[i] = dnx_dx + dny_dy;
            }
        }

        return kappa;
    }

    /**
     * Marching squares — extract zero-level set as polyline (2D analogue
     * of marching cubes).  Used by AmbiAnamorph for silhouette extraction.
     *
     * @param {Float32Array} sdf
     * @param {Float32Array} narrowBandMask
     * @param {number}       width
     * @param {number}       height
     * @param {number}       [isovalue=0]
     * @returns {{ vertices: Float32Array, edges: Uint32Array }}
     */
    sdfToMesh(sdf, narrowBandMask, width, height, isovalue = 0) {
        const vertices = [];
        const edges    = [];

        // Marching squares table (16 cases → edge list)
        // Bit layout: TL=8, TR=4, BR=2, BL=1 (above threshold = 1)
        const edgeTable = [
            [], [3,0], [0,1], [3,1], [1,2], [0,2,3,1], [0,1,1,2],
            [3,2], [2,3], [1,3,0,2], [0,3,2,3], [1,2,0,1], [1,3],
            [0,2], [3,0], [],
        ];

        const lerp = (a, b, t) => a + t * (b - a);
        const vIdx = new Map();
        const getV = (x, y) => {
            const k = `${x},${y}`;
            if (!vIdx.has(k)) { vIdx.set(k, vertices.length / 2); vertices.push(x, y); }
            return vIdx.get(k);
        };

        for (let y = 0; y < height - 1; y++) {
            for (let x = 0; x < width - 1; x++) {
                const i00 = y * width + x;
                const i10 = i00 + 1;
                const i01 = i00 + width;
                const i11 = i01 + 1;

                if (!narrowBandMask[i00] && !narrowBandMask[i10] &&
                    !narrowBandMask[i01] && !narrowBandMask[i11]) continue;

                const s00 = this._sdfSafe(sdf, i00);
                const s10 = this._sdfSafe(sdf, i10);
                const s01 = this._sdfSafe(sdf, i01);
                const s11 = this._sdfSafe(sdf, i11);

                const config = ((s00 >= isovalue ? 8 : 0) | (s10 >= isovalue ? 4 : 0) |
                                (s11 >= isovalue ? 2 : 0) | (s01 >= isovalue ? 1 : 0));

                const pairs = edgeTable[config];
                for (let e = 0; e < pairs.length; e += 2) {
                    // Edge endpoints: interpolate crossing position
                    const edgeA = pairs[e], edgeB = pairs[e + 1];
                    const vA = this._marchingSquaresVertex(edgeA, x, y, s00, s10, s01, s11, isovalue, lerp, getV);
                    const vB = this._marchingSquaresVertex(edgeB, x, y, s00, s10, s01, s11, isovalue, lerp, getV);
                    edges.push(vA, vB);
                }
            }
        }

        return {
            vertices: new Float32Array(vertices),
            edges:    new Uint32Array(edges),
        };
    }

    // =========================================================================
    //  DISK SEED UTILITIES  (consumed by Stage 4B)
    // =========================================================================

    /** Filter disk seeds by modal label. */
    getDisksByModalLabel(diskSeeds, label) {
        return diskSeeds.filter(s => s.modalLabel === label);
    }

    /** Filter disk seeds by directness value range. */
    getDisksByDirectnessRange(diskSeeds, min, max) {
        return diskSeeds.filter(s => s.directness >= min && s.directness <= max);
    }

    /**
     * Project a disk seed into world coordinates given depth map and camera
     * intrinsics.  Stage 4B calls this before minimisation.
     *
     * @param {DiskSeed} disk
     * @param {Float32Array} depthMap
     * @param {{ fx, fy, cx, cy }} intrinsics — pinhole camera model
     * @returns {{ worldXYZ: [number,number,number], worldNormal: [number,number,number] }}
     */
    projectDiskToWorld(disk, depthMap, intrinsics) {
        const [px, py] = disk.imageXY;
        const depth = depthMap[py * /* width TBD */ 1 + px] || disk.depth;
        const { fx = 1, fy = 1, cx = 0, cy = 0 } = intrinsics || {};

        const X = (px - cx) * depth / fx;
        const Y = (py - cy) * depth / fy;
        const Z = depth;

        return {
            worldXYZ:    [X, Y, Z],
            worldNormal: disk.normal,
        };
    }

    /**
     * Compute pairwise overlap fractions between disk seeds.
     * Two disks overlap if distance between centres < (r1 + r2).
     * Returns flat array of overlap fractions, index [i*n + j].
     *
     * @param {Array<DiskSeed>} diskSeeds
     * @returns {Float32Array} overlap fractions (n×n, symmetric)
     */
    computeDiskOverlap(diskSeeds) {
        const n   = diskSeeds.length;
        const out = new Float32Array(n * n);

        for (let i = 0; i < n; i++) {
            const [ax, ay] = diskSeeds[i].imageXY;
            const ri = diskSeeds[i].radius;
            for (let j = i + 1; j < n; j++) {
                const [bx, by] = diskSeeds[j].imageXY;
                const rj = diskSeeds[j].radius;
                const dist = Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
                const sumR = ri + rj;
                const overlap = sumR > 0 ? Math.max(0, 1 - dist / sumR) : 0;
                out[i * n + j] = overlap;
                out[j * n + i] = overlap;
            }
        }

        return out;
    }

    // =========================================================================
    //  NARROW BAND MORPHOLOGICAL UTILITIES
    // =========================================================================

    /**
     * Morphological dilation of the narrow band mask.
     * @param {Float32Array|Uint8Array} mask
     * @param {number} width
     * @param {number} height
     * @param {number} dilationPx — dilation radius in pixels
     * @returns {Uint8Array} dilated mask (binary)
     */
    dilateNarrowBand(mask, width, height, dilationPx) {
        const n = width * height;
        const out = new Uint8Array(n);
        const r   = dilationPx;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                let found = false;
                outer: for (let dy = -r; dy <= r && !found; dy++) {
                    for (let dx = -r; dx <= r && !found; dx++) {
                        if (dx * dx + dy * dy > r * r) continue;
                        const ny_ = y + dy, nx_ = x + dx;
                        if (ny_ >= 0 && ny_ < height && nx_ >= 0 && nx_ < width) {
                            if (mask[ny_ * width + nx_] > 0.5) found = true;
                        }
                    }
                }
                out[y * width + x] = found ? 1 : 0;
            }
        }
        return out;
    }

    /**
     * Morphological erosion of the narrow band mask.
     * @param {Float32Array|Uint8Array} mask
     * @param {number} width
     * @param {number} height
     * @param {number} erosionPx — erosion radius in pixels
     * @returns {Uint8Array} eroded mask (binary)
     */
    erodeNarrowBand(mask, width, height, erosionPx) {
        const n = width * height;
        const out = new Uint8Array(n);
        const r   = erosionPx;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (mask[y * width + x] <= 0.5) { out[y * width + x] = 0; continue; }
                let allSet = true;
                outer: for (let dy = -r; dy <= r && allSet; dy++) {
                    for (let dx = -r; dx <= r && allSet; dx++) {
                        if (dx * dx + dy * dy > r * r) continue;
                        const ny_ = y + dy, nx_ = x + dx;
                        if (ny_ >= 0 && ny_ < height && nx_ >= 0 && nx_ < width) {
                            if (mask[ny_ * width + nx_] <= 0.5) allSet = false;
                        } else {
                            allSet = false;
                        }
                    }
                }
                out[y * width + x] = allSet ? 1 : 0;
            }
        }
        return out;
    }

    /**
     * Compute statistics for the narrow band mask.
     * @param {Float32Array|Uint8Array} mask
     * @param {number} width
     * @param {number} height
     * @returns {{ pixelCount, fraction, boundingBox }}
     */
    narrowBandStats(mask, width, height) {
        let count = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (mask[y * width + x] > 0.5) {
                    count++;
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                }
            }
        }

        return {
            pixelCount:  count,
            fraction:    count / (width * height),
            boundingBox: count > 0 ? { minX, maxX, minY, maxY } : null,
        };
    }

    // =========================================================================
    //  SDF BOOLEAN OPERATIONS  (for Stage 4B constraint surface construction)
    // =========================================================================

    /** SDF union: min(a, b) — smallest enclosing shape. */
    sdfUnion(sdfA, sdfB, count) {
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = Math.min(sdfA[i], sdfB[i]);
        return out;
    }

    /** SDF intersection: max(a, b) — region inside both shapes. */
    sdfIntersection(sdfA, sdfB, count) {
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = Math.max(sdfA[i], sdfB[i]);
        return out;
    }

    /** SDF difference: max(a, -b) — shape A minus shape B. */
    sdfDifference(sdfA, sdfB, count) {
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = Math.max(sdfA[i], -sdfB[i]);
        return out;
    }

    /** SDF offset: outward expansion (positive) or contraction (negative). */
    sdfOffset(sdf, count, offset) {
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = sdf[i] - offset;
        return out;
    }

    // =========================================================================
    //  SERIALIZATION  (for PascalSterling / cross-device transfer)
    // =========================================================================

    /**
     * Serialize PackingSDF result to compact binary bundle.
     * PascalSterling (Stage 8) consumes the header + payload and uses the
     * narrow_band_mask to guide its mandatory quadtree split positions.
     *
     * @param {Object} result — Output of compute()
     * @param {Object} [opts]
     * @param {boolean} [opts.includeSeeds=true]
     * @param {boolean} [opts.includeDiagnostics=false]
     * @returns {{ header: Object, payload: ArrayBuffer }}
     */
    serialize(result, opts = {}) {
        const { includeSeeds = true, includeDiagnostics = false } = opts;
        const { signedSdf, narrowBandMask, diskSeeds, densityMap, meta } = result;

        const n = signedSdf.length;
        const seedCount = includeSeeds ? diskSeeds.length : 0;

        // Layout: [signedSdf f32][narrowBandMask f32][densityMap f32][seeds...]
        const SEED_STRIDE = 10; // floats per seed: x, y, nx, ny, nz, r, depth, directness, label, density
        const byteLen = (n * 3 + seedCount * SEED_STRIDE) * 4;
        const buf     = new ArrayBuffer(byteLen);
        const view    = new DataView(buf);
        let off       = 0;

        const writeF32Array = (arr) => {
            for (let i = 0; i < arr.length; i++) {
                view.setFloat32(off, arr[i] ?? 0, true); off += 4;
            }
        };

        writeF32Array(signedSdf);
        writeF32Array(narrowBandMask);
        writeF32Array(densityMap);

        if (includeSeeds) {
            for (const s of diskSeeds) {
                view.setFloat32(off, s.imageXY[0],  true); off += 4;
                view.setFloat32(off, s.imageXY[1],  true); off += 4;
                view.setFloat32(off, s.normal[0],   true); off += 4;
                view.setFloat32(off, s.normal[1],   true); off += 4;
                view.setFloat32(off, s.normal[2],   true); off += 4;
                view.setFloat32(off, s.radius,      true); off += 4;
                view.setFloat32(off, s.depth,       true); off += 4;
                view.setFloat32(off, s.directness,  true); off += 4;
                view.setFloat32(off, s.modalLabel,  true); off += 4;
                view.setFloat32(off, s.density,     true); off += 4;
            }
        }

        const header = {
            version:       '1.0.0',
            stage:         2,
            module:        'PackingSDF',
            width:         meta.width,
            height:        meta.height,
            pixelCount:    n,
            seedCount,
            umbraPolicy:   meta.umbraPolicy,
            sdfRange:      meta.sdfRange,
            narrowBandPx:  meta.narrowBandPixels,
            telemetry:     meta.telemetry,
            samplingContext: meta.samplingContext,
            byteLength:    byteLen,
            seedStride:    SEED_STRIDE,
            gptConstants:  {
                delta2D:  GPT_DELTA_2D,
                delta3D:  GPT_DELTA_3D,
                alpha:    GPT_ALPHA,
            },
        };

        if (includeDiagnostics && result.scaleneVariance) {
            header.hasDiagnostics = true;
            // Could extend payload — omitted here for size
        }

        return { header, payload: buf };
    }

    /**
     * Deserialize a PackingSDF bundle produced by serialize().
     *
     * @param {Object}      header
     * @param {ArrayBuffer} payload
     * @returns {Object} Reconstructed result (without diagnostic fields)
     */
    deserialize(header, payload) {
        const n   = header.pixelCount;
        const view = new DataView(payload);
        let off    = 0;

        const readF32Array = (len) => {
            const arr = new Float32Array(len);
            for (let i = 0; i < len; i++) {
                arr[i] = view.getFloat32(off, true); off += 4;
            }
            return arr;
        };

        const signedSdf     = readF32Array(n);
        const narrowBandMask = readF32Array(n);
        const densityMap    = readF32Array(n);

        const diskSeeds = [];
        for (let s = 0; s < header.seedCount; s++) {
            const x   = view.getFloat32(off, true); off += 4;
            const y   = view.getFloat32(off, true); off += 4;
            const nx  = view.getFloat32(off, true); off += 4;
            const ny  = view.getFloat32(off, true); off += 4;
            const nz  = view.getFloat32(off, true); off += 4;
            const r   = view.getFloat32(off, true); off += 4;
            const d   = view.getFloat32(off, true); off += 4;
            const dir = view.getFloat32(off, true); off += 4;
            const lbl = view.getFloat32(off, true); off += 4;
            const den = view.getFloat32(off, true); off += 4;

            diskSeeds.push({
                imageXY:    [x, y],
                xNorm:      x / header.width,
                yNorm:      y / header.height,
                worldXYZ:   null,
                normal:     [nx, ny, nz],
                radius:     r,
                depth:      d,
                directness: dir,
                modalLabel: lbl,
                density:    den,
            });
        }

        return {
            signedSdf, narrowBandMask, diskSeeds, densityMap,
            meta: {
                width:           header.width,
                height:          header.height,
                sdfRange:        header.sdfRange,
                seedCount:       header.seedCount,
                narrowBandPixels: header.narrowBandPx,
                umbraPolicy:     header.umbraPolicy,
                samplingContext: header.samplingContext,
                telemetry:       header.telemetry,
            },
        };
    }

    // =========================================================================
    //  PRIVATE HELPERS
    // =========================================================================

    /** SDF-safe access: returns 0 for NaN pixels. */
    _sdfSafe(sdf, i) {
        const v = sdf[i];
        return isNaN(v) ? 0 : v;
    }

    /**
     * SDF gradient magnitude — used as the variance signal fed to MultiSampler
     * in place of pixel-luminance variance.  High near zero-level set
     * (surface), falls off away from surface — exactly the geometry that
     * Wallis-based sampling was designed to find.
     */
    _computeSdfGradientMagnitude(sdf, width, height) {
        const { magnitude } = this.computeSdfGradient(sdf, width, height);
        // Normalise to [0,1] for MultiSampler input
        let maxMag = 0;
        for (let i = 0; i < magnitude.length; i++) {
            if (!isNaN(magnitude[i]) && magnitude[i] > maxMag) maxMag = magnitude[i];
        }
        if (maxMag > 0) {
            for (let i = 0; i < magnitude.length; i++) magnitude[i] /= maxMag;
        }
        return magnitude;
    }

    /**
     * Fast box blur — used to smooth density field and SDF gradient before
     * feeding MultiSampler.  Prevents hard modal-label voids.
     *
     * @param {Float32Array} field
     * @param {number} width
     * @param {number} height
     * @param {number} radius — blur radius in pixels
     * @returns {Float32Array} smoothed field
     */
    _boxBlur(field, width, height, radius) {
        const n   = width * height;
        const tmp = new Float32Array(n);
        const out = new Float32Array(n);
        const r   = Math.max(0, Math.round(radius));

        // Horizontal pass
        for (let y = 0; y < height; y++) {
            let sum = 0, cnt = 0;
            // Prime the window
            for (let x = 0; x <= Math.min(r, width - 1); x++) {
                sum += field[y * width + x]; cnt++;
            }
            for (let x = 0; x < width; x++) {
                if (x + r + 1 < width) { sum += field[y * width + x + r + 1]; cnt++; }
                if (x - r - 1 >= 0)    { sum -= field[y * width + x - r - 1]; cnt--; }
                tmp[y * width + x] = cnt > 0 ? sum / cnt : 0;
            }
        }

        // Vertical pass
        for (let x = 0; x < width; x++) {
            let sum = 0, cnt = 0;
            for (let y = 0; y <= Math.min(r, height - 1); y++) {
                sum += tmp[y * width + x]; cnt++;
            }
            for (let y = 0; y < height; y++) {
                if (y + r + 1 < height) { sum += tmp[(y + r + 1) * width + x]; cnt++; }
                if (y - r - 1 >= 0)     { sum -= tmp[(y - r - 1) * width + x]; cnt--; }
                out[y * width + x] = cnt > 0 ? sum / cnt : 0;
            }
        }

        return out;
    }

    /**
     * Classic smoothstep: hermite interpolation in [edge0, edge1].
     * Returns 0 if x ≤ edge0, 1 if x ≥ edge1.
     */
    _smoothstep(edge0, edge1, x) {
        const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }

    /**
     * Helper for marching squares vertex interpolation.
     * Edge encoding: 0=top, 1=right, 2=bottom, 3=left
     */
    _marchingSquaresVertex(edge, cx, cy, s00, s10, s01, s11, iso, lerp, getV) {
        switch (edge) {
            case 0: { const t = (iso - s00) / (s10 - s00 + 1e-10); return getV(lerp(cx, cx+1, t), cy); }
            case 1: { const t = (iso - s10) / (s11 - s10 + 1e-10); return getV(cx+1, lerp(cy, cy+1, t)); }
            case 2: { const t = (iso - s01) / (s11 - s01 + 1e-10); return getV(lerp(cx, cx+1, t), cy+1); }
            case 3: { const t = (iso - s00) / (s01 - s00 + 1e-10); return getV(cx, lerp(cy, cy+1, t)); }
            default: return getV(cx, cy);
        }
    }

    _log(msg, data) {
        if (this._cfg.enableDebug) console.log(`[PackingSDF] ${msg}`, data ?? '');
    }
}

export default PackingSDF;