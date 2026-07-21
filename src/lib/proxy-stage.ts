/**
 * proxy-stage.ts — etapa 5B del pipeline: transcode paralelo de los clips
 * 'leccion' a proxies de edición 1080p30, escritos en
 * jobs/<id>/assets/proxies/.
 *
 * Lee plan/structure.json para determinar el set de clips fuente usados por
 * alguna lección (los únicos que necesitan proxy: broll/descartar/otro_curso
 * no se editan). Por cada clip corre ffmpeg-static con parámetros fijos
 * (scale 1920x1080, 30fps, h264/aac) y persiste el progreso en
 * progress/prep-progress.json en cada transición, con el mismo patrón de
 * mini-pool que transcribe/index.ts.
 *
 * INVARIANTE: igual que las demás etapas deterministas, esta etapa SOLO LEE
 * de source/ (para transcodificar); jamás escribe, mueve ni borra nada ahí
 * dentro (ver invariante en jobs.ts).
 */
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// ffmpeg-static exporta la ruta al binario de ffmpeg empaquetado, mismo
// patrón que frames-stage.ts y transcribe/narration.ts.
import ffmpegPath from "ffmpeg-static";
import {
  proxiesDir,
  readStructureJson,
  sourcePath,
  writePrepProgressJson,
} from "./jobs";
import { PROXY_FPS, PROXY_HEIGHT, PROXY_WIDTH } from "./constants";
import type { FileTranscriptStatus, ProgressJson } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Cantidad de transcodes concurrentes. El transcode con libx264 es CPU-bound
 * (no I/O-bound como la transcripción o el probing), así que no conviene
 * saturar todos los núcleos: por defecto se deja al menos 2 núcleos libres
 * para el resto del sistema/servidor, con un tope de 4 para no generar
 * demasiados procesos ffmpeg en paralelo en máquinas grandes, y un piso de 1
 * para no quedar en 0 en máquinas de pocos núcleos.
 */
function resolveConcurrency(): number {
  const raw = process.env.PROXY_CONCURRENCY;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  const cpuBudget = os.cpus().length - 2;
  return Math.max(1, Math.min(4, cpuBudget));
}

/** Ruta absoluta al proxy final (no temporal) de un clip dentro de assets/proxies/. */
function proxyOutPath(jobId: string, clip: string): string {
  const baseName = path.basename(clip, path.extname(clip));
  return path.join(proxiesDir(jobId), `${baseName}.mp4`);
}

/**
 * Extrae el set de nombres de archivo de clip usados por alguna lección de
 * structure.json (sin duplicados). Solo estos clips necesitan proxy: el
 * resto (broll/descartar/otro_curso) queda en apartados y nunca se edita.
 */
function collectLessonClips(structure: {
  modules: Array<{
    lessons: Array<{ segments: Array<{ clip: string }> }>;
  }>;
}): string[] {
  const clips = new Set<string>();
  for (const module of structure.modules) {
    for (const lesson of module.lessons) {
      for (const segment of lesson.segments) {
        clips.add(segment.clip);
      }
    }
  }
  return Array.from(clips);
}

/**
 * Determina si ya existe un proxy válido y reutilizable para un clip: el
 * archivo <clip>.mp4 debe existir en assets/proxies/ y ser más nuevo que su
 * source/<clip> correspondiente. Esto hace que re-correr la etapa sea barato
 * (no re-transcodifica clips ya procesados) mientras siga siendo correcto
 * ante un source/ que cambió (por ejemplo, un job re-ingerido).
 */
async function proxyIsUpToDate(
  srcFile: string,
  outFile: string
): Promise<boolean> {
  try {
    const [srcStat, outStat] = await Promise.all([
      fs.stat(srcFile),
      fs.stat(outFile),
    ]);
    return outStat.mtimeMs > srcStat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Mini-pool de concurrencia (mismo patrón que transcribe/index.ts y
 * frames-stage.ts): procesa `items` con a lo sumo `concurrency` tareas en
 * simultáneo, sin dependencias externas. Los errores individuales se manejan
 * dentro de `worker` y no abortan el resto.
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
 * Transcodifica un único clip a proxy de edición. Escribe primero a
 * <clip>.mp4.tmp y solo al terminar con éxito lo renombra a <clip>.mp4: así
 * un proceso interrumpido a mitad de camino (crash, kill, etc.) nunca deja
 * un proxy a medio escribir que después se confunda con uno completo.
 *
 * Nota sobre clips sin pista de audio: no agregamos ningún flag condicional
 * para ese caso. Con -i <src> sin stream de audio, ffmpeg simplemente no
 * produce salida de audio con estos argumentos (no hay stream que codificar
 * con -c:a aac), sin fallar el proceso.
 */
async function transcodeClip(srcFile: string, outFile: string): Promise<void> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static no disponible");
  }
  const tmpOut = `${outFile}.tmp`;
  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      srcFile,
      "-vf",
      `scale=${PROXY_WIDTH}:${PROXY_HEIGHT}`,
      "-r",
      String(PROXY_FPS),
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-preset",
      "medium",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      tmpOut,
    ]);
    await fs.rename(tmpOut, outFile);
  } catch (err) {
    // Si ffmpeg falla, limpiamos el .tmp para no dejar basura, y propagamos
    // el stderr completo (execFile lo adjunta en err.stderr) para que quede
    // registrado en el progress y sea diagnosticable sin volver a correr.
    await fs.rm(tmpOut, { force: true }).catch(() => {});
    const stderr =
      typeof err === "object" && err !== null && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "")
        : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(stderr ? `${message}\n${stderr}` : message);
  }
}

/**
 * Corre la etapa de generación de proxies (5B) para un job: lee
 * plan/structure.json, determina los clips 'leccion' (usados por alguna
 * lección), transcodifica en paralelo los que falten a assets/proxies/ y
 * persiste el progreso en progress/prep-progress.json en cada transición.
 *
 * NUNCA toca jobs/<id>/source/: solo lo lee para transcodificar (ver
 * invariante en el header de este archivo y en jobs.ts).
 */
export async function runProxyStage(jobId: string): Promise<void> {
  const structure = await readStructureJson(jobId);
  if (!structure) {
    throw new Error(
      "No hay plan/structure.json: corre la etapa de plan antes de generar proxies"
    );
  }

  const clips = collectLessonClips(structure);

  await fs.mkdir(proxiesDir(jobId), { recursive: true });

  // Progreso inicial: todos 'pending'.
  const progress: ProgressJson = {
    files: Object.fromEntries(
      clips.map((clip) => [clip, { status: "pending" as FileTranscriptStatus }])
    ),
  };
  await writePrepProgressJson(jobId, progress);

  async function setStatus(
    clip: string,
    status: FileTranscriptStatus,
    error?: string
  ): Promise<void> {
    progress.files[clip] = error ? { status, error } : { status };
    await writePrepProgressJson(jobId, progress);
  }

  const concurrency = resolveConcurrency();

  await runPool(clips, concurrency, async (clip) => {
    const srcFile = path.join(sourcePath(jobId), clip);
    const outFile = proxyOutPath(jobId, clip);

    // Re-corrible barato: si el proxy ya existe y es más nuevo que el
    // source, lo damos por hecho y saltamos el transcode (costoso en CPU).
    if (await proxyIsUpToDate(srcFile, outFile)) {
      await setStatus(clip, "done");
      return;
    }

    await setStatus(clip, "running");
    try {
      await transcodeClip(srcFile, outFile);
      // Un error individual no aborta el resto de los clips.
      await setStatus(clip, "done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setStatus(clip, "error", message);
    }
  });
}
