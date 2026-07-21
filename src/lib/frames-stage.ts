/**
 * frames-stage.ts — etapa de muestreo de frames de referencia con ffmpeg
 * (etapa 3.5 del pipeline).
 *
 * Lee probe/media.json (duraciones) y transcripts/summary.json (narración
 * por archivo, generado por la etapa 3). Si summary.json todavía no existe
 * lanza un error claro: hay que transcribir antes de muestrear frames.
 *
 * Por cada clip calcula un set de timestamps según tenga narración o no,
 * extrae un JPG por timestamp con ffmpeg-static y escribe frames/manifest.json.
 *
 * INVARIANTE: igual que transcribe/index.ts, esta etapa SOLO LEE de source/
 * (para extraer los frames); jamás escribe, mueve ni borra nada ahí dentro.
 * frames/ en cambio se borra y recrea por completo en cada corrida para que
 * re-muestrear sea idempotente.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// ffmpeg-static exporta la ruta al binario de ffmpeg empaquetado, igual que
// en transcribe/narration.ts: evita depender de un ffmpeg instalado global.
import ffmpegPath from "ffmpeg-static";
import {
  framesDir,
  readMediaJson,
  sourcePath,
  transcriptsDir,
  writeFramesManifest,
} from "./jobs";
import type { FrameEntry, FramesManifest, ManifestClip } from "./types";

const execFileAsync = promisify(execFile);

/** Cantidad de extracciones de frames concurrentes (mini-pool sin dependencias nuevas). */
function resolveConcurrency(): number {
  const raw = Number(process.env.FRAMES_CONCURRENCY ?? "4");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
}

/** Quita la extensión de un nombre de archivo para usarlo como nombre de carpeta de salida. */
function stripExtension(filename: string): string {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

/** Resumen de un archivo tal como lo persiste transcribe/index.ts en summary.json. */
interface SummaryFileEntry {
  filename: string;
  narration: boolean;
  durationSeconds: number;
  status: string;
}

interface SummaryJson {
  files: SummaryFileEntry[];
}

/**
 * Lee transcripts/summary.json. Si el archivo no existe, la etapa de
 * transcripción todavía no corrió (o falló antes de escribirlo): sin
 * narration/duración por archivo no podemos decidir la estrategia de
 * muestreo, así que lanzamos un error claro en vez de adivinar.
 */
async function readSummaryJson(jobId: string): Promise<SummaryJson> {
  try {
    const raw = await fs.readFile(
      path.join(transcriptsDir(jobId), "summary.json"),
      "utf-8"
    );
    return JSON.parse(raw) as SummaryJson;
  } catch {
    throw new Error("Ejecuta la transcripción antes de muestrear frames");
  }
}

/** Tope máximo de frames por clip de B-roll denso (contra videos larguísimos sin narración). */
const BROLL_MAX_FRAMES = 80;

/** Separación en segundos entre frames consecutivos de un clip B-roll. */
const BROLL_STEP_SECONDS = 4.5;

/**
 * Calcula los timestamps (en segundos, sin redondear todavía) a muestrear
 * para un clip según tenga narración o no.
 *
 * - Con narración: 4 puntos fijos relativos a la duración (15/40/65/90%).
 *   Cubren inicio, dos tercios intermedios y cierre del relato sin depender
 *   de dónde caigan los cortes de frase.
 * - Sin narración (B-roll): muestreo denso cada 4.5s. Arrancamos en t=2 (no
 *   en 0) para evitar el frame negro/en blanco típico del primer instante de
 *   un clip, y terminamos en duración-0.5 para evitar el frame de
 *   fade-out/corte abrupto del final. Se capea en BROLL_MAX_FRAMES para no
 *   generar cientos de JPGs de un B-roll de varios minutos.
 */
function computeTimestamps(narration: boolean, durationSeconds: number): number[] {
  if (narration) {
    return [0.15, 0.4, 0.65, 0.9].map((fraction) => fraction * durationSeconds);
  }

  const start = 2;
  const end = durationSeconds - 0.5;
  const raw: number[] = [];
  for (let t = start; t <= end && raw.length < BROLL_MAX_FRAMES; t += BROLL_STEP_SECONDS) {
    raw.push(t);
  }
  return raw;
}

/**
 * Redondea a segundo entero (nombre de archivo/manifest en enteros), quita
 * duplicados que puedan surgir del redondeo, preservando el orden, y luego
 * clampea cada timestamp a Math.max(0, Math.floor(durationSeconds) - 1).
 *
 * El redondeo (Math.round) puede sumar hasta +0.5s a un timestamp crudo. Si
 * ese timestamp ya estaba pegado al final del clip (ej. la ventana B-roll
 * termina en duracion-0.5), el redondeo lo puede empujar a/pasado la
 * duración total (ej. 24.5 -> 25 en un clip de 25.0s). ffmpeg -ss en/tras el
 * EOF falla silenciosamente y ese frame se descarta, reduciendo el conteo
 * sin avisar. Clampeamos después de redondear y volvemos a deduplicar
 * (el clamp puede generar nuevos duplicados) para evitarlo.
 */
function roundAndDedup(timestamps: number[], durationSeconds: number): number[] {
  const maxTimestamp = Math.max(0, Math.floor(durationSeconds) - 1);
  const rounded = timestamps
    .map((t) => Math.max(0, Math.round(t)))
    .filter((t) => Number.isFinite(t))
    .map((t) => Math.min(t, maxTimestamp));
  return Array.from(new Set(rounded));
}

/**
 * Extrae un único frame con ffmpeg-static: mismo patrón de spawn que
 * measureAudioEnergy en transcribe/narration.ts, pero vía execFile porque
 * no necesitamos leer stdout/stderr en streaming, solo esperar a que termine.
 */
async function extractFrame(
  sourceFile: string,
  timeSeconds: number,
  outFile: string
): Promise<void> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static no disponible");
  }
  await execFileAsync(ffmpegPath, [
    "-ss",
    String(timeSeconds),
    "-i",
    sourceFile,
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2",
    "-q:v",
    "3",
    "-y",
    outFile,
  ]);
}

/**
 * Mini-pool de concurrencia (mismo patrón que transcribe/index.ts): procesa
 * `items` con a lo sumo `concurrency` tareas en simultáneo sin dependencias
 * externas. Los errores individuales se manejan dentro de `worker` y no
 * abortan el resto.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const currentIndex = nextIndex;
    nextIndex += 1;
    if (currentIndex >= items.length) return;
    await worker(items[currentIndex]);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    runNext()
  );
  await Promise.all(workers);
}

/**
 * Corre la etapa de muestreo de frames completa de un job: lee media.json y
 * transcripts/summary.json, borra y recrea frames/ (idempotente), extrae los
 * JPGs de cada clip con ffmpeg y escribe frames/manifest.json.
 *
 * NUNCA toca jobs/<id>/source/: solo lo lee para extraer los frames (ver
 * invariante en el header de este archivo y en jobs.ts).
 */
export async function runFramesStage(jobId: string): Promise<FramesManifest> {
  const summary = await readSummaryJson(jobId);
  const media = await readMediaJson(jobId);

  // frames/ se borra por completo y se recrea para que re-muestrear el job
  // sea idempotente (no deja JPGs viejos de una corrida anterior con otra
  // estrategia de muestreo).
  const outDir = framesDir(jobId);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const concurrency = resolveConcurrency();
  const clips: ManifestClip[] = [];

  for (const fileSummary of summary.files) {
    const { filename, narration } = fileSummary;
    // media.json (si existe) tiene la duración más confiable de probe;
    // si no, caemos de vuelta a la duración reportada por summary.json.
    const mediaEntry = media?.find((m) => m.filename === filename);
    const durationSeconds = mediaEntry?.durationSeconds ?? fileSummary.durationSeconds;

    // Si el cálculo normal (narrado o B-roll) deja la lista vacía —típico de
    // un clip B-roll cortísimo cuya ventana [2, dur-0.5] no cabe, o de un
    // narrado ultracorto— caemos al punto medio del clip. Un clip sin ningún
    // frame deja ciego al agente que consume el manifest, que es justo lo
    // que esta etapa existe para evitar: mejor 1 frame de compromiso que 0.
    let timestamps = roundAndDedup(
      computeTimestamps(narration, durationSeconds),
      durationSeconds
    );
    if (timestamps.length === 0) {
      timestamps = [Math.max(0, Math.round(durationSeconds / 2))];
    }
    const clipDirName = stripExtension(filename);
    const clipOutDir = path.join(outDir, clipDirName);
    await fs.mkdir(clipOutDir, { recursive: true });

    const srcFile = path.join(sourcePath(jobId), filename);
    const extractedFrames: FrameEntry[] = [];

    await runPool(timestamps, concurrency, async (timeSeconds) => {
      const frameName = `frame_${String(timeSeconds).padStart(4, "0")}.jpg`;
      const outFile = path.join(clipOutDir, frameName);
      try {
        await extractFrame(srcFile, timeSeconds, outFile);
        extractedFrames.push({
          timeSeconds,
          file: `${clipDirName}/${frameName}`,
        });
      } catch (err) {
        // Un frame que falla se omite del manifest sin abortar el resto del
        // clip ni del job (por ejemplo, timestamp fuera de rango en un clip
        // más corto de lo reportado).
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `frames-stage: no se pudo extraer frame en ${filename}@${timeSeconds}s: ${message}`
        );
      }
    });

    // Ordenamos por timeSeconds: el pool puede terminar las tareas en
    // cualquier orden.
    extractedFrames.sort((a, b) => a.timeSeconds - b.timeSeconds);

    clips.push({
      filename,
      narration,
      durationSeconds,
      frames: extractedFrames,
    });
  }

  const manifest: FramesManifest = {
    generatedAt: new Date().toISOString(),
    clips,
  };

  await writeFramesManifest(jobId, manifest);
  return manifest;
}
