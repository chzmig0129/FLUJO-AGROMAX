/**
 * gate2-frames-stage.ts — etapa determinista de extracción de frames del
 * render final de una clase (etapa 14 del diseño: Gate 2, QA visual).
 *
 * A diferencia de frames-stage.ts (etapa 3.5, que muestrea los CLIPS
 * ORIGINALES de source/ para ayudar al agente de planificación), esta etapa
 * muestrea render/<lessonId>.mp4: el video YA ENSAMBLADO que un humano o un
 * agente verá. El objetivo es dar evidencia visual concreta —no solo
 * "ffprobe dice que mide lo que debía"— de que el intro, los captions y el
 * resto del video quedaron bien.
 *
 * Tres tipos de frames, cada uno con un propósito distinto:
 *   - 'intro': 1 frame fijo en t=2.5s (mitad del intro de 5s), para
 *     confirmar que el intro se ve bien sin tener que abrir el video.
 *   - 'caption': 3 frames alineados a captions concretos (primero, medio,
 *     último de plan/captions/<lessonId>.json), para confirmar que el texto
 *     karaoke se ve legible y en el lugar correcto.
 *   - 'random': 8 frames aleatorios uniformes sobre el resto del video, para
 *     pescar cualquier cosa rota (glitch de corte, freeze, negro) que un
 *     muestreo dirigido no vería.
 *
 * Idempotente: qa/gate2/frames/<lessonId>/ se borra y recrea en cada
 * corrida, igual que frames/ en frames-stage.ts.
 *
 * INVARIANTE: esta etapa SOLO LEE render/<lessonId>.mp4 y
 * plan/captions/<lessonId>.json; nunca escribe ni toca render/ ni plan/.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegBin } from "./ffmpeg";
import { ffprobePath } from "./probe";
import { INTRO_DURATION_FRAMES } from "./constants";
import {
  gate2FramesDir,
  readCaptionsJson,
  renderPath,
  writeGate2FramesManifest,
} from "./jobs";
import type { Gate2Frame, Gate2FramesManifest } from "./types";

const execFileAsync = promisify(execFile);

/** Cantidad de frames aleatorios uniformes a extraer del resto del video. */
const RANDOM_FRAME_COUNT = 8;

/** Timestamp fijo (segundos) del frame dirigido al intro (5s de intro, mitad). */
const INTRO_FRAME_TIME_SECONDS = 2.5;

/** Margen (segundos) que se deja al final del video al elegir frames aleatorios, para no caer justo en el último frame/EOF. */
const RANDOM_WINDOW_END_MARGIN_SECONDS = 1;

/** Margen (segundos) que se deja tras el intro al elegir frames aleatorios. */
const RANDOM_WINDOW_START_MARGIN_SECONDS = 1;

/** Duración/fps que ffprobe reporta sobre render/<lessonId>.mp4. */
interface RenderProbe {
  durationSeconds: number;
  fps: number;
}

/**
 * Corre ffprobe sobre el render final para obtener su duración y fps. Usa el
 * mismo binario (ffprobePath, de probe.ts) que ya usan probeVideo y
 * assembly/verify.ts, para no duplicar la resolución del binario.
 */
async function probeRenderDuration(file: string): Promise<RenderProbe> {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "stream=avg_frame_rate,codec_type",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; avg_frame_rate?: string }>;
    format?: { duration?: string };
  };

  const video = (parsed.streams ?? []).find((s) => s.codec_type === "video");
  const [num, den] = (video?.avg_frame_rate ?? "0/1").split("/");
  const fps = Number(den) === 0 ? 0 : Number(num) / Number(den);
  const durationSeconds = Number(parsed.format?.duration ?? 0);

  return { durationSeconds, fps };
}

/**
 * Extrae un único frame a resolución completa del video con ffmpeg
 * (-frames:v 1, sin -vf scale a diferencia de frames-stage.ts: acá se
 * necesita ver el render tal como lo verá el usuario final, no una miniatura).
 */
async function extractFullResFrame(
  videoPath: string,
  timeSeconds: number,
  outFile: string
): Promise<void> {
  const ffmpegBin = resolveFfmpegBin();
  await execFileAsync(ffmpegBin, [
    "-ss",
    String(timeSeconds),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-y",
    outFile,
  ]);
}

/**
 * Elige hasta 3 índices de captions repartidos (primero, medio, último),
 * deduplicados y ordenados, para clases con pocos captions (donde primero,
 * medio y último podrían coincidir).
 */
function pickCaptionIndices(count: number): number[] {
  if (count <= 0) return [];
  const first = 0;
  const last = count - 1;
  const mid = Math.floor(last / 2);
  return Array.from(new Set([first, mid, last])).sort((a, b) => a - b);
}

/**
 * Redondea un timestamp a 0.1s (mismo criterio que la extracción, así los
 * nombres de archivo de los frames aleatorios son legibles y estables).
 */
function roundToTenth(t: number): number {
  return Math.round(t * 10) / 10;
}

/**
 * Genera `count` timestamps aleatorios uniformes dentro de [start, end],
 * redondeados a 0.1s y sin duplicados. Si el rango es demasiado angosto
 * para `count` valores distintos a esa resolución, devuelve los que
 * alcancen (mejor menos frames aleatorios que timestamps repetidos que
 * pisarían el mismo archivo).
 */
function pickRandomTimestamps(
  start: number,
  end: number,
  count: number
): number[] {
  if (end <= start) return [];
  const seen = new Set<number>();
  // Tope de intentos generoso para no colgarse si el rango es angosto: con
  // 0.1s de resolución un rango de más de 1s ya tiene margen de sobra para
  // 8 valores distintos, pero un rango angosto puede necesitar varios
  // intentos para completar el cupo (o directamente no llegar).
  const maxAttempts = count * 50;
  for (let attempts = 0; attempts < maxAttempts && seen.size < count; attempts += 1) {
    const candidate = roundToTenth(start + Math.random() * (end - start));
    seen.add(candidate);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Corre la etapa de extracción de frames de Gate 2 para una clase: valida
 * que render/<lessonId>.mp4 exista, mide su duración/fps con ffprobe, elige
 * 1 frame de intro + 3 de captions + 8 aleatorios, los extrae a resolución
 * completa con ffmpeg y escribe manifest.json. Borra y recrea el directorio
 * de frames de esa lección en cada corrida (idempotente).
 */
export async function runGate2FramesStage(
  jobId: string,
  lessonId: string
): Promise<Gate2FramesManifest> {
  const videoPath = renderPath(jobId, lessonId);
  try {
    await fs.access(videoPath);
  } catch {
    throw new Error(
      `No existe render/${lessonId}.mp4: corre el ensamblaje antes del QA visual (Gate 2)`
    );
  }

  const { durationSeconds, fps } = await probeRenderDuration(videoPath);
  if (durationSeconds <= 0 || fps <= 0) {
    throw new Error(
      `render/${lessonId}.mp4 no tiene duración/fps legibles: no se puede muestrear`
    );
  }

  // qa/gate2/frames/<lessonId>/ se borra y recrea por completo para que
  // re-muestrear sea idempotente (no deja PNGs de una corrida anterior).
  const outDir = gate2FramesDir(jobId, lessonId);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const toExtract: Array<{ kind: Gate2Frame["kind"]; timeSeconds: number; file: string }> =
    [];

  // 1) Frame dirigido al intro: fijo en t=2.5s, solo si la clase tiene intro.
  if (INTRO_DURATION_FRAMES > 0) {
    toExtract.push({
      kind: "intro",
      timeSeconds: INTRO_FRAME_TIME_SECONDS,
      file: "intro.png",
    });
  }

  // 2) 3 frames dirigidos a captions: primero, medio y último de
  // plan/captions/<lessonId>.json, convertidos a segundos del render final
  // (offset de intro + midFrame del caption, sobre el fps de captions.json).
  const captionsFile = await readCaptionsJson(jobId, lessonId);
  if (captionsFile && captionsFile.captions.length > 0) {
    const captionFps = captionsFile.fps > 0 ? captionsFile.fps : fps;
    const indices = pickCaptionIndices(captionsFile.captions.length);
    indices.forEach((captionIndex, position) => {
      const caption = captionsFile.captions[captionIndex];
      const midFrame = Math.floor((caption.startFrame + caption.endFrame) / 2);
      const timeSeconds = (INTRO_DURATION_FRAMES + midFrame) / captionFps;
      toExtract.push({
        kind: "caption",
        timeSeconds,
        file: `caption_${position + 1}.png`,
      });
    });
  }

  // 3) 8 frames aleatorios uniformes en [intro_end+1, duration-1].
  const introEndSeconds = INTRO_DURATION_FRAMES / fps;
  const randomStart = introEndSeconds + RANDOM_WINDOW_START_MARGIN_SECONDS;
  const randomEnd = durationSeconds - RANDOM_WINDOW_END_MARGIN_SECONDS;
  const randomTimestamps = pickRandomTimestamps(
    randomStart,
    randomEnd,
    RANDOM_FRAME_COUNT
  );
  randomTimestamps.forEach((timeSeconds) => {
    toExtract.push({
      kind: "random",
      timeSeconds,
      file: `random_${timeSeconds.toFixed(1)}.png`,
    });
  });

  const frames: Gate2Frame[] = [];
  for (const item of toExtract) {
    // Clampeado defensivo: un timestamp calculado a partir de captions
    // podría, en teoría, caer fuera de [0, duration) si el caption más
    // avanzado tocara el borde del render; ffmpeg -ss en/tras el EOF falla
    // silenciosamente y no queremos perder el frame por eso.
    const clamped = Math.min(
      Math.max(0, item.timeSeconds),
      Math.max(0, durationSeconds - 0.05)
    );
    const outFile = path.join(outDir, item.file);
    await extractFullResFrame(videoPath, clamped, outFile);
    frames.push({ file: item.file, kind: item.kind, timeSeconds: clamped });
  }

  const manifest: Gate2FramesManifest = {
    lessonId,
    generatedAt: new Date().toISOString(),
    videoPath,
    durationSeconds,
    frames,
  };

  await writeGate2FramesManifest(jobId, manifest);
  return manifest;
}
