// Face recognition — runs fully on-device, no network calls of any kind.
//
// Ported from the Amino Farms payroll module's face.ts, with one change:
// @vladmandic/human and its model weight files are bundled into the app
// (via the npm package + `scripts/copy-face-models.mjs`, which copies
// node_modules/@vladmandic/human/models into public/models at build time)
// instead of being fetched from a CDN. This app has to work with zero
// connectivity, so there is no CDN fallback here at all.
//
// No biometric data ever leaves the device: embeddings are stored in the
// local IndexedDB and matching happens on-device.

let humanPromise: Promise<any> | null = null;

const MODEL_BASE = "/models/";

/** Similarity above which we auto-accept a match. See Amino Farms' face.ts
 * for the score-distribution reasoning this threshold is based on. */
export const DEFAULT_MATCH_THRESHOLD = 0.65;

/** Minimum gap between the top match and the runner-up for an auto-accept. */
export const MIN_MATCH_MARGIN = 0.05;

/** Minimum anti-spoof ("real face") score to accept a capture. */
export const MIN_REAL_SCORE = 0.6;

export function looksSpoofed(face: { real?: number; live?: number }): boolean {
  const real = typeof face.real === "number" ? face.real : null;
  const live = typeof face.live === "number" ? face.live : null;
  if (real !== null && real < MIN_REAL_SCORE) return true;
  if (live !== null && live < MIN_REAL_SCORE) return true;
  return false;
}

export async function loadFaceEngine(): Promise<any> {
  if (!humanPromise) {
    humanPromise = (async () => {
      const mod: any = await import("@vladmandic/human");
      const Human = mod.Human ?? mod.default;
      const human = new Human({
        modelBasePath: MODEL_BASE,
        cacheSensitivity: 0,
        filter: { enabled: true, equalization: true },
        face: {
          enabled: true,
          detector: { rotation: true, maxDetected: 5, minConfidence: 0.4 },
          mesh: { enabled: true },
          iris: { enabled: false },
          emotion: { enabled: false },
          description: { enabled: true }, // produces the embedding
          antispoof: { enabled: true },
          liveness: { enabled: true },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
        segmentation: { enabled: false },
      });
      await human.load();
      return human;
    })().catch((err) => {
      humanPromise = null; // allow retry
      throw err;
    });
  }
  return humanPromise;
}

export interface FaceResult {
  ok: boolean;
  embedding?: number[];
  faceCount: number;
  confidence?: number;
  real?: number;
  live?: number;
  error?: string;
}

export async function getFaceEmbedding(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): Promise<FaceResult> {
  const human = await loadFaceEngine();
  const DETECT_TIMEOUT_MS = 10_000;
  const result: any = await Promise.race([
    human.detect(input),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Face detection timed out — try again")), DETECT_TIMEOUT_MS),
    ),
  ]);
  const faces = (result?.face || []).filter((f: any) => Array.isArray(f.embedding) && f.embedding.length > 0);
  if (faces.length === 0) {
    return { ok: false, faceCount: 0, error: "No face detected" };
  }
  if (faces.length > 1) {
    faces.sort((a: any, b: any) => (b.box?.[2] || 0) * (b.box?.[3] || 0) - (a.box?.[2] || 0) * (a.box?.[3] || 0));
  }
  const face = faces[0];
  return {
    ok: true,
    embedding: Array.from(face.embedding as number[]),
    faceCount: faces.length,
    confidence: face.faceScore ?? face.score,
    real: typeof face.real === "number" ? face.real : undefined,
    live: typeof face.live === "number" ? face.live : undefined,
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface MatchCandidate {
  id: string;
  descriptor: number[];
}

export interface MatchResult {
  id: string | null;
  score: number;
  secondScore: number;
}

export function findBestMatch(embedding: number[], candidates: MatchCandidate[]): MatchResult {
  let best: string | null = null;
  let bestScore = -1;
  let secondScore = -1;
  for (const c of candidates) {
    const s = cosineSimilarity(embedding, c.descriptor);
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      best = c.id;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }
  return { id: best, score: Math.max(0, bestScore), secondScore: Math.max(0, secondScore) };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

export function frameToDataUrl(source: HTMLVideoElement | HTMLCanvasElement, maxWidth = 400, quality = 0.6): string {
  const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  const scale = Math.min(1, maxWidth / (srcW || maxWidth));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}
