/**
 * gate3-stage.ts — etapa "Gate 3" del diseño (etapa 15): juez de módulo, vía
 * el comando headless `/gate3-modulo` de Claude Code (suscripción, con
 * visión: el CLI lee los PNGs muestreados con Read), usando el motor
 * genérico de `plan/claude-code-engine.ts`.
 *
 * A diferencia de Gate 2 (que audita UNA clase ya renderizada, frame por
 * frame), Gate 3 audita un MÓDULO completo: coherencia entre sus clases
 * (secuencia, títulos vs. structure.json, temas huérfanos/duplicados) y
 * consistencia visual cross-clase (mismo estilo de subtítulo, sin saltos
 * raros entre clases distintas). Para eso necesita frames de VARIAS
 * lecciones del módulo a la vez, no solo de una.
 *
 * Dos partes, en secuencia:
 *   1) Parte determinista (esta misma función): lee `plan/structure.json`,
 *      encuentra las lecciones del módulo que ya tienen
 *      `render/<lessonId>.mp4`, y extrae 12-15 frames aleatorios repartidos
 *      entre ellas (3-4 por lección) a
 *      `jobs/<jobId>/qa/gate3/frames/<moduleId>/`, con un `manifest.json`.
 *   2) Dispara `/gate3-modulo <jobId> <moduleId>` vía
 *      `runCommandViaClaudeCode`, y verifica en disco que produjo un
 *      veredicto real y válido en `qa/gate3/<moduleId>.json` — el CLI puede
 *      salir con código 0 sin haber completado el trabajo real, igual que
 *      Gate 2 y las demás etapas que delegan en `claude-code-engine.ts`.
 *
 * INVARIANTE: no se toca `jobs.ts` — las rutas de `qa/gate3/...` se
 * construyen acá mismo con `qaDir()` (de jobs.ts) + `path.join` inline, en
 * vez de agregar helpers nuevos a jobs.ts.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegBin } from "./ffmpeg";
import { ffprobePath } from "./probe";
import { runCommandViaClaudeCode } from "./plan/claude-code-engine";
import { jobPath, qaDir, renderPath, readStructureJson } from "./jobs";

const execFileAsync = promisify(execFile);

/** Veredictos aceptados como válidos en `qa/gate3/<moduleId>.json`. */
const VALID_VERDICTS = new Set(["APPROVED", "REJECTED"]);

/** Total de frames aleatorios que se intenta repartir entre las lecciones del módulo. */
const MIN_TOTAL_FRAMES = 12;
const MAX_TOTAL_FRAMES = 15;

/** Frames por lección: mínimo y máximo, según el diseño ("3-4 c/u"). */
const MIN_FRAMES_PER_LESSON = 3;
const MAX_FRAMES_PER_LESSON = 4;

/** Margen (segundos) al elegir timestamps aleatorios, para no caer justo en el borde del video. */
const RANDOM_WINDOW_MARGIN_SECONDS = 1;

/** Un frame del muestreo cross-clase de Gate 3, con su lección de origen. */
export interface Gate3Frame {
  /** Nombre del PNG dentro de `qa/gate3/frames/<moduleId>/`. */
  file: string;
  /** Lección (dentro del módulo) de la que se extrajo el frame. */
  lessonId: string;
  /** Timestamp (segundos) dentro de `render/<lessonId>.mp4` de donde se extrajo. */
  timeSeconds: number;
}

/** Contrato de `qa/gate3/frames/<moduleId>/manifest.json`. */
export interface Gate3FramesManifest {
  moduleId: string;
  generatedAt: string;
  frames: Gate3Frame[];
}

/** Timeout máximo (en minutos) para la corrida completa del comando /gate3-modulo. */
function resolveGate3TimeoutMin(): number {
  const minutes = Number(process.env.GATE3_TIMEOUT_MIN ?? "25");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 25;
}

/** Ruta absoluta al subdirectorio de Gate 3 (QA de módulo) de un job. */
function gate3Dir(jobId: string): string {
  return path.join(qaDir(jobId), "gate3");
}

/** Ruta absoluta al subdirectorio de frames extraídos de Gate 3 de un módulo. */
function gate3FramesDir(jobId: string, moduleId: string): string {
  return path.join(gate3Dir(jobId), "frames", moduleId);
}

/** Ruta absoluta a `qa/gate3/frames/<moduleId>/manifest.json` de un job. */
function gate3ManifestPath(jobId: string, moduleId: string): string {
  return path.join(gate3FramesDir(jobId, moduleId), "manifest.json");
}

/** Ruta absoluta al veredicto de Gate 3 de un módulo: `qa/gate3/<moduleId>.json`. */
function gate3VerdictPath(jobId: string, moduleId: string): string {
  return path.join(gate3Dir(jobId), `${moduleId}.json`);
}

/** Verifica (tolerante) si `render/<lessonId>.mp4` ya existe. */
async function hasRenderedLesson(jobId: string, lessonId: string): Promise<boolean> {
  try {
    await fs.access(renderPath(jobId, lessonId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lee `plan/structure.json`, encuentra el módulo `moduleId` y devuelve los
 * ids de sus lecciones que ya tienen `render/<lessonId>.mp4`. Devuelve un
 * array vacío si el módulo no existe o ninguna de sus lecciones fue
 * renderizada todavía — quien llama decide qué hacer con eso (400 en la
 * ruta HTTP, error en la etapa determinista).
 */
export async function listRenderedLessonsInModule(
  jobId: string,
  moduleId: string
): Promise<string[]> {
  const structure = await readStructureJson(jobId);
  if (!structure) return [];

  const targetModule = structure.modules.find((m) => m.id === moduleId);
  if (!targetModule) return [];

  const rendered: string[] = [];
  for (const lesson of targetModule.lessons) {
    if (await hasRenderedLesson(jobId, lesson.id)) {
      rendered.push(lesson.id);
    }
  }
  return rendered;
}

/**
 * Corre ffprobe sobre un render final para obtener su duración en segundos.
 * Usa el mismo binario (`ffprobePath`, de `probe.ts`) que ya usan
 * `probeVideo` y `gate2-frames-stage.ts`, para no duplicar su resolución.
 */
async function probeDurationSeconds(file: string): Promise<number> {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  return Number(parsed.format?.duration ?? 0);
}

/**
 * Extrae un único frame a resolución completa del video con ffmpeg
 * (`-frames:v 1`, sin `-vf scale`), igual que `gate2-frames-stage.ts`: acá
 * se necesita ver el render tal como lo verá el usuario final.
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
 * Redondea un timestamp a 0.1s (mismos criterios que `gate2-frames-stage.ts`,
 * así los nombres de archivo son legibles y estables).
 */
function roundToTenth(t: number): number {
  return Math.round(t * 10) / 10;
}

/**
 * Genera `count` timestamps aleatorios uniformes dentro de `[start, end]`,
 * redondeados a 0.1s y sin duplicados. Mismo criterio que
 * `pickRandomTimestamps` de `gate2-frames-stage.ts`: mejor devolver menos
 * timestamps que timestamps repetidos.
 */
function pickRandomTimestamps(start: number, end: number, count: number): number[] {
  if (end <= start || count <= 0) return [];
  const seen = new Set<number>();
  const maxAttempts = count * 50;
  for (let attempts = 0; attempts < maxAttempts && seen.size < count; attempts += 1) {
    const candidate = roundToTenth(start + Math.random() * (end - start));
    seen.add(candidate);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Decide cuántos frames extraer de cada lección: arranca en
 * `MIN_FRAMES_PER_LESSON` para todas, y va sumando de a una (round-robin,
 * sin superar `MAX_FRAMES_PER_LESSON` por lección) hasta llegar a
 * `MIN_TOTAL_FRAMES` frames en total (sin pasarse de `MAX_TOTAL_FRAMES`).
 * Con módulos de muchas lecciones (más de 5), el total puede terminar por
 * encima de `MAX_TOTAL_FRAMES` aun así: se prioriza respetar el rango
 * "3-4 por lección" del diseño antes que el tope global, que es una guía
 * pensada para el caso típico de 3-5 lecciones por módulo.
 */
function distributeFrameCounts(lessonCount: number): number[] {
  if (lessonCount <= 0) return [];
  const counts = new Array(lessonCount).fill(MIN_FRAMES_PER_LESSON) as number[];
  let total = counts.reduce((a, b) => a + b, 0);
  let i = 0;
  const safetyLimit = lessonCount * MAX_FRAMES_PER_LESSON * 2;
  let iterations = 0;
  while (total < MIN_TOTAL_FRAMES && total < MAX_TOTAL_FRAMES && iterations < safetyLimit) {
    const idx = i % lessonCount;
    if (counts[idx] < MAX_FRAMES_PER_LESSON) {
      counts[idx] += 1;
      total += 1;
    }
    i += 1;
    iterations += 1;
  }
  return counts;
}

/**
 * Extrae los frames aleatorios repartidos entre las lecciones renderizadas
 * del módulo y escribe `manifest.json`. Borra y recrea el directorio de
 * frames del módulo en cada corrida (idempotente, igual que Gate 2).
 */
async function extractGate3Frames(
  jobId: string,
  moduleId: string,
  lessonIds: string[]
): Promise<Gate3FramesManifest> {
  const outDir = gate3FramesDir(jobId, moduleId);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const perLessonCounts = distributeFrameCounts(lessonIds.length);
  const frames: Gate3Frame[] = [];

  for (let lessonIndex = 0; lessonIndex < lessonIds.length; lessonIndex += 1) {
    const lessonId = lessonIds[lessonIndex];
    const frameCount = perLessonCounts[lessonIndex];
    const videoPath = renderPath(jobId, lessonId);

    const durationSeconds = await probeDurationSeconds(videoPath);
    if (durationSeconds <= 0) {
      throw new Error(
        `render/${lessonId}.mp4 no tiene duración legible: no se puede muestrear para Gate 3`
      );
    }

    const start = RANDOM_WINDOW_MARGIN_SECONDS;
    const end = Math.max(start, durationSeconds - RANDOM_WINDOW_MARGIN_SECONDS);
    const timestamps = pickRandomTimestamps(start, end, frameCount);

    for (let frameIndex = 0; frameIndex < timestamps.length; frameIndex += 1) {
      const timeSeconds = timestamps[frameIndex];
      const clamped = Math.min(
        Math.max(0, timeSeconds),
        Math.max(0, durationSeconds - 0.05)
      );
      const file = `${lessonId}_${frameIndex + 1}.png`;
      const outFile = path.join(outDir, file);
      await extractFullResFrame(videoPath, clamped, outFile);
      frames.push({ file, lessonId, timeSeconds: clamped });
    }
  }

  const manifest: Gate3FramesManifest = {
    moduleId,
    generatedAt: new Date().toISOString(),
    frames,
  };

  await fs.writeFile(
    gate3ManifestPath(jobId, moduleId),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return manifest;
}

/**
 * Verifica que la corrida haya producido un veredicto real y parseable de
 * Gate 3, porque el CLI puede terminar con exit code 0 sin haber escrito
 * nada (ej. si se detuvo antes de completar la auditoría de módulo).
 */
async function verifyGate3Outputs(jobId: string, moduleId: string): Promise<void> {
  const verdictPath = gate3VerdictPath(jobId, moduleId);

  let raw: string;
  try {
    raw = await fs.readFile(verdictPath, "utf-8");
  } catch {
    throw new Error(
      `La etapa Gate 3 (claude-code) terminó sin generar '${verdictPath}' para el módulo '${moduleId}' del job '${jobId}'. El comando /gate3-modulo no completó su trabajo.`
    );
  }

  let verdict: { verdict?: string } | null = null;
  try {
    verdict = JSON.parse(raw) as { verdict?: string };
  } catch {
    verdict = null;
  }

  if (!verdict || !VALID_VERDICTS.has(verdict.verdict ?? "")) {
    throw new Error(
      `La etapa Gate 3 (claude-code) escribió '${verdictPath}' para el módulo '${moduleId}' del job '${jobId}' pero sin un veredicto válido (APPROVED|REJECTED).`
    );
  }
}

/**
 * Corre la etapa Gate 3 completa para un módulo de un job:
 *  1) lee `plan/structure.json`, encuentra las lecciones del módulo que ya
 *     tienen `render/<lessonId>.mp4` (error si ninguna la tiene);
 *  2) extrae 12-15 frames aleatorios repartidos entre esas lecciones y
 *     escribe `qa/gate3/frames/<moduleId>/manifest.json`;
 *  3) dispara `/gate3-modulo <jobId> <moduleId>` vía
 *     `runCommandViaClaudeCode` y verifica que produjo un veredicto válido
 *     en `qa/gate3/<moduleId>.json`.
 */
export async function runGate3Stage(jobId: string, moduleId: string): Promise<void> {
  // Confirma que el job existe en disco (jobPath se usa acá solo para dar un
  // mensaje de error más claro si alguien llama a esta función directamente
  // sin haber verificado el job antes, como sí hace la ruta HTTP).
  await fs.access(jobPath(jobId)).catch(() => {
    throw new Error(`No existe el job '${jobId}'`);
  });

  const lessonIds = await listRenderedLessonsInModule(jobId, moduleId);
  if (lessonIds.length === 0) {
    throw new Error(
      `No se puede correr Gate 3: el módulo '${moduleId}' del job '${jobId}' no tiene ninguna lección con 'render/<lessonId>.mp4' todavía (falta ensamblar al menos una clase del módulo primero).`
    );
  }

  await extractGate3Frames(jobId, moduleId, lessonIds);

  await runCommandViaClaudeCode({
    command: "gate3-modulo",
    args: `${jobId} ${moduleId}`,
    timeoutMin: resolveGate3TimeoutMin(),
  });

  await verifyGate3Outputs(jobId, moduleId);
}
