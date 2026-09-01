/**
 * DJ.Studio-style Harmonize / Automix: order tracks for mix flow using
 * Camelot key + BPM only (no lyrics). Models an open-path TSP and solves
 * exactly for small sets, greedy + 2-opt for larger ones.
 */
import {
  keyRelationship,
  parseCamelot,
  bpmClosenessScore,
} from "./camelot.js";

export type AutomixTrack = {
  id: string;
  artist: string;
  title: string;
  spotifyId: string;
  bpm: number;
  camelot: string;
  energy: number;
};

export type AutomixMode = "mood" | "fuzzy";

export type AutomixOptions = {
  /** Max tracks in the mix (subset of eligible). Default: all eligible. */
  maxTracks?: number;
  /** 0 = BPM only, 1 = key only. Default 0.55 (slight key bias, like DJ.Studio balance). */
  keyWeight?: number;
  /** Soft BPM scale for scoring (not a hard gate). Default 12. */
  bpmTolerance?: number;
  /** mood = classic Camelot; fuzzy = number-focused (ignore A/B). */
  mode?: AutomixMode;
};

export type AutomixTransition = {
  fromIndex: number;
  toIndex: number;
  bpmDelta: number;
  keyRelationship: string;
  keyScore: number;
  bpmScore: number;
  score: number;
  quality: "great" | "good" | "ok" | "weak";
};

export type AutomixResult = {
  tracks: AutomixTrack[];
  transitions: AutomixTransition[];
  averageScore: number;
  greatTransitions: number;
  eligibleCount: number;
  skippedMissingMeta: number;
  algorithm: string;
  options: Required<Pick<AutomixOptions, "keyWeight" | "bpmTolerance" | "mode">> & {
    maxTracks: number;
  };
};

function numDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 12 - d);
}

/**
 * Continuous 0–1 key compatibility for sequencing.
 * Mood follows Mixed In Key-style moves; Fuzzy prioritizes Camelot numbers.
 */
export function keyMixScore(a: string, b: string, mode: AutomixMode): number {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return 0;

  if (mode === "fuzzy") {
    const d = numDistance(pa.num, pb.num);
    if (d === 0) return 1;
    if (d === 1) return 0.9;
    if (d === 2) return 0.55;
    if (d === 3) return 0.25;
    return 0.05;
  }

  if (pa.num === pb.num && pa.letter === pb.letter) return 1;
  if (pa.num === pb.num && pa.letter !== pb.letter) return 0.95;
  if (pa.letter === pb.letter && numDistance(pa.num, pb.num) === 1) return 0.9;
  // Energy boost (+2 hours, same letter)
  if (pa.letter === pb.letter && numDistance(pa.num, pb.num) === 2) return 0.6;
  // Diagonal / mood change-ish
  if (numDistance(pa.num, pb.num) === 1 && pa.letter !== pb.letter) return 0.45;
  if (pa.letter === pb.letter && numDistance(pa.num, pb.num) === 3) return 0.25;
  return 0.05;
}

function transitionScore(
  a: AutomixTrack,
  b: AutomixTrack,
  keyWeight: number,
  bpmTol: number,
  mode: AutomixMode,
): { score: number; keyScore: number; bpmScore: number } {
  const keyScore = keyMixScore(a.camelot, b.camelot, mode);
  const bpmScore = bpmClosenessScore(a.bpm, b.bpm, bpmTol);
  const score = keyWeight * keyScore + (1 - keyWeight) * bpmScore;
  return { score, keyScore, bpmScore };
}

function qualityFromScore(score: number): AutomixTransition["quality"] {
  if (score >= 0.82) return "great";
  if (score >= 0.65) return "good";
  if (score >= 0.45) return "ok";
  return "weak";
}

function buildCostMatrix(
  tracks: AutomixTrack[],
  keyWeight: number,
  bpmTol: number,
  mode: AutomixMode,
): Float64Array {
  const n = tracks.length;
  const cost = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        cost[i * n + j] = Infinity;
        continue;
      }
      const { score } = transitionScore(tracks[i], tracks[j], keyWeight, bpmTol, mode);
      cost[i * n + j] = 1 - score;
    }
  }
  return cost;
}

/** Exact open-path TSP via Held–Karp DP. Feasible up to ~18 tracks. */
function heldKarpPath(cost: Float64Array, n: number): { order: number[]; totalCost: number } {
  const full = (1 << n) - 1;
  const size = full + 1;
  const dp = new Float64Array(size * n);
  const parent = new Int16Array(size * n);
  dp.fill(Infinity);
  parent.fill(-1);

  for (let i = 0; i < n; i++) {
    dp[(1 << i) * n + i] = 0;
  }

  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * n + j];
      if (!Number.isFinite(cur)) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const nextMask = mask | (1 << k);
        const nextCost = cur + cost[j * n + k];
        const idx = nextMask * n + k;
        if (nextCost < dp[idx]) {
          dp[idx] = nextCost;
          parent[idx] = j;
        }
      }
    }
  }

  let bestEnd = 0;
  let bestCost = Infinity;
  for (let j = 0; j < n; j++) {
    const c = dp[full * n + j];
    if (c < bestCost) {
      bestCost = c;
      bestEnd = j;
    }
  }

  const order: number[] = [];
  let mask = full;
  let j = bestEnd;
  while (j >= 0) {
    order.push(j);
    const p = parent[mask * n + j];
    mask ^= 1 << j;
    j = p;
  }
  order.reverse();
  return { order, totalCost: bestCost };
}

function pathCost(order: number[], cost: Float64Array, n: number): number {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) {
    total += cost[order[i] * n + order[i + 1]];
  }
  return total;
}

function nearestNeighborPath(
  cost: Float64Array,
  n: number,
  start: number,
): number[] {
  const used = new Uint8Array(n);
  const order = [start];
  used[start] = 1;
  while (order.length < n) {
    const last = order[order.length - 1];
    let best = -1;
    let bestC = Infinity;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const c = cost[last * n + j];
      if (c < bestC) {
        bestC = c;
        best = j;
      }
    }
    if (best < 0) break;
    used[best] = 1;
    order.push(best);
  }
  return order;
}

/** Grow a path of length `limit` from `start` by always adding the best unused neighbor. */
function greedyGrowPath(
  cost: Float64Array,
  n: number,
  start: number,
  limit: number,
): number[] {
  const used = new Uint8Array(n);
  const order = [start];
  used[start] = 1;
  while (order.length < limit) {
    const last = order[order.length - 1];
    let best = -1;
    let bestC = Infinity;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const c = cost[last * n + j];
      if (c < bestC) {
        bestC = c;
        best = j;
      }
    }
    if (best < 0) break;
    used[best] = 1;
    order.push(best);
  }
  return order;
}

function twoOpt(order: number[], cost: Float64Array, n: number): number[] {
  const path = order.slice();
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < path.length - 2; i++) {
      for (let k = i + 1; k < path.length - 1; k++) {
        const a = path[i];
        const b = path[i + 1];
        const c = path[k];
        const d = path[k + 1];
        const before = cost[a * n + b] + cost[c * n + d];
        const after = cost[a * n + c] + cost[b * n + d];
        if (after + 1e-12 < before) {
          // reverse segment i+1..k
          for (let L = i + 1, R = k; L < R; L++, R--) {
            const t = path[L];
            path[L] = path[R];
            path[R] = t;
          }
          improved = true;
        }
      }
    }
  }
  return path;
}

function multiStartHeuristic(
  cost: Float64Array,
  n: number,
  startCount = 12,
): { order: number[]; totalCost: number } {
  const starts = Array.from({ length: n }, (_, i) => i);
  // Prefer diverse starts: spread by index when many tracks
  const chosen: number[] = [];
  const step = Math.max(1, Math.floor(n / startCount));
  for (let i = 0; i < n && chosen.length < startCount; i += step) {
    chosen.push(starts[i]);
  }
  for (let i = 0; i < n && chosen.length < startCount; i++) {
    if (!chosen.includes(i)) chosen.push(i);
  }

  let bestOrder: number[] = nearestNeighborPath(cost, n, 0);
  let bestCost = pathCost(bestOrder, cost, n);

  for (const s of chosen) {
    let order = nearestNeighborPath(cost, n, s);
    order = twoOpt(order, cost, n);
    const c = pathCost(order, cost, n);
    if (c < bestCost) {
      bestCost = c;
      bestOrder = order;
    }
  }
  return { order: bestOrder, totalCost: bestCost };
}

function selectSubsetPath(
  cost: Float64Array,
  n: number,
  maxTracks: number,
  startCount = 16,
): { order: number[]; totalCost: number } {
  const starts = Array.from({ length: n }, (_, i) => i);
  const step = Math.max(1, Math.floor(n / startCount));
  const chosen: number[] = [];
  for (let i = 0; i < n && chosen.length < startCount; i += step) {
    chosen.push(starts[i]);
  }

  let bestOrder: number[] = greedyGrowPath(cost, n, 0, maxTracks);
  let bestCost = pathCost(bestOrder, cost, n);

  for (const s of chosen) {
    let order = greedyGrowPath(cost, n, s, maxTracks);
    // 2-opt within the subset indices (local path)
    const localN = order.length;
    const localCost = new Float64Array(localN * localN);
    for (let i = 0; i < localN; i++) {
      for (let j = 0; j < localN; j++) {
        localCost[i * localN + j] =
          i === j ? Infinity : cost[order[i] * n + order[j]];
      }
    }
    const localOrder = twoOpt(
      Array.from({ length: localN }, (_, i) => i),
      localCost,
      localN,
    );
    order = localOrder.map((i) => order[i]);
    const c = pathCost(order, cost, n);
    if (c < bestCost) {
      bestCost = c;
      bestOrder = order;
    }
  }
  return { order: bestOrder, totalCost: bestCost };
}

function orderTracks(
  tracks: AutomixTrack[],
  maxTracks: number,
  keyWeight: number,
  bpmTol: number,
  mode: AutomixMode,
): { ordered: AutomixTrack[]; algorithm: string } {
  const n = tracks.length;
  if (n === 0) return { ordered: [], algorithm: "empty" };
  if (n === 1) return { ordered: tracks.slice(), algorithm: "single" };

  const cost = buildCostMatrix(tracks, keyWeight, bpmTol, mode);
  const limit = Math.min(maxTracks, n);

  if (limit < n) {
    const { order } = selectSubsetPath(cost, n, limit);
    return {
      ordered: order.map((i) => tracks[i]),
      algorithm: `subset-greedy-2opt(${limit} of ${n})`,
    };
  }

  if (n <= 16) {
    const { order } = heldKarpPath(cost, n);
    return {
      ordered: order.map((i) => tracks[i]),
      algorithm: `held-karp(${n})`,
    };
  }

  const { order } = multiStartHeuristic(cost, n);
  return {
    ordered: order.map((i) => tracks[i]),
    algorithm: `greedy-2opt(${n})`,
  };
}

export function buildAutomix(
  candidates: AutomixTrack[],
  skippedMissingMeta: number,
  options: AutomixOptions = {},
): AutomixResult {
  const keyWeight = Math.min(1, Math.max(0, options.keyWeight ?? 0.55));
  const bpmTolerance = Math.max(1, options.bpmTolerance ?? 12);
  const mode: AutomixMode = options.mode === "fuzzy" ? "fuzzy" : "mood";
  const eligibleCount = candidates.length;
  const maxTracks = Math.max(
    2,
    Math.min(options.maxTracks ?? eligibleCount, eligibleCount || 2),
  );

  if (eligibleCount < 2) {
    return {
      tracks: candidates.slice(0, Math.max(0, eligibleCount)),
      transitions: [],
      averageScore: 0,
      greatTransitions: 0,
      eligibleCount,
      skippedMissingMeta,
      algorithm: "need-2-tracks",
      options: { maxTracks, keyWeight, bpmTolerance, mode },
    };
  }

  const { ordered, algorithm } = orderTracks(
    candidates,
    maxTracks,
    keyWeight,
    bpmTolerance,
    mode,
  );

  const transitions: AutomixTransition[] = [];
  let scoreSum = 0;
  let greatTransitions = 0;
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i];
    const b = ordered[i + 1];
    const { score, keyScore, bpmScore } = transitionScore(
      a,
      b,
      keyWeight,
      bpmTolerance,
      mode,
    );
    const quality = qualityFromScore(score);
    if (quality === "great") greatTransitions++;
    scoreSum += score;
    transitions.push({
      fromIndex: i,
      toIndex: i + 1,
      bpmDelta: Math.abs(a.bpm - b.bpm),
      keyRelationship: keyRelationship(a.camelot, b.camelot),
      keyScore,
      bpmScore,
      score,
      quality,
    });
  }

  return {
    tracks: ordered,
    transitions,
    averageScore: transitions.length ? scoreSum / transitions.length : 0,
    greatTransitions,
    eligibleCount,
    skippedMissingMeta,
    algorithm,
    options: { maxTracks, keyWeight, bpmTolerance, mode },
  };
}
