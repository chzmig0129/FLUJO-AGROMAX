/**
 * gate2-stage.ts — etapa "Gate 2" del diseño: juez de QA visual por clase,
 * vía el comando headless `/gate2-clase` de Claude Code (suscripción, con
 * visión: el CLI lee los PNGs muestreados con Read), usando el motor
 * genérico de `plan/claude-code-engine.ts`.
 *
 * Prerequisito real: `qa/gate2/frames/<lessonId>/manifest.json` ya existe
 * (lo produce `runGate2FramesStage` en `gate2-frames-stage.ts`, corrida
 * antes por quien orqueste esta etapa — ver `/api/jobs/[jobId]/gate2`).
 * Dispara el comando, y verifica en disco que produjo un veredicto real y
 * válido en `qa/gate2/<lessonId>.json` — el CLI puede salir con código 0 sin
 * haber completado el trabajo real, igual que las demás etapas que delegan
 * en `claude-code-engine.ts`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  runCommandViaClaudeCode,
  runCommandsInPool,
  resolveModelForRole,
} from "./plan/claude-code-engine";
import { jobPath, gate2VerdictPath, readGate2Verdict, renderDir } from "./jobs";
import { runGate2FramesStage } from "./gate2-frames-stage";

/** Veredictos aceptados como válidos en `qa/gate2/<lessonId>.json`. */
const VALID_VERDICTS = new Set(["APPROVED", "REJECTED"]);

/** Timeout máximo (en minutos) para la corrida completa del comando /gate2-clase. */
function resolveGate2TimeoutMin(): number {
  const minutes = Number(process.env.GATE2_TIMEOUT_MIN ?? "20");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 20;
}

/** Ruta absoluta al manifest de frames de Gate 2 de una lección. */
function gate2FramesManifestPath(jobId: string, lessonId: string): string {
  return path.join(jobPath(jobId), "qa", "gate2", "frames", lessonId, "manifest.json");
}

/**
 * Verifica (tolerante) si el manifest de frames de Gate 2 de la lección ya
 * existe. Se usa tanto acá (guard previo a disparar el comando) como podría
 * usarse desde la ruta HTTP.
 */
export async function hasGate2Frames(jobId: string, lessonId: string): Promise<boolean> {
  try {
    await fs.access(gate2FramesManifestPath(jobId, lessonId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Corre la etapa Gate 2 invocando `/gate2-clase <jobId> <lessonId>` vía
 * `runCommandViaClaudeCode`, y luego verifica en disco que la corrida
 * produjo `qa/gate2/<lessonId>.json` con un veredicto válido.
 */
export async function runGate2Stage(jobId: string, lessonId: string): Promise<void> {
  const ok = await hasGate2Frames(jobId, lessonId);
  if (!ok) {
    throw new Error(
      `No se puede correr Gate 2: el job '${jobId}' no tiene 'qa/gate2/frames/${lessonId}/manifest.json' (falta correr la etapa de muestreo de frames de Gate 2 primero).`,
    );
  }

  await runCommandViaClaudeCode({
    command: "gate2-clase",
    args: `${jobId} ${lessonId}`,
    timeoutMin: resolveGate2TimeoutMin(),
  });

  await verifyGate2Outputs(jobId, lessonId);
}

/**
 * Verifica que la corrida haya producido un veredicto real y parseable de
 * Gate 2, porque el CLI puede terminar con exit code 0 sin haber escrito
 * nada (ej. si se detuvo antes de completar la auditoría visual).
 */
async function verifyGate2Outputs(jobId: string, lessonId: string): Promise<void> {
  const verdictPath = gate2VerdictPath(jobId, lessonId);

  let verdict: { verdict?: string } | null = null;
  try {
    verdict = (await readGate2Verdict(jobId, lessonId)) as { verdict?: string } | null;
  } catch {
    verdict = null;
  }

  if (!verdict || !VALID_VERDICTS.has(verdict.verdict ?? "")) {
    throw new Error(
      `La etapa Gate 2 (claude-code) terminó sin generar un veredicto válido en '${verdictPath}' para la lección '${lessonId}' del job '${jobId}'. El comando /gate2-clase no completó su trabajo.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * runGate2AllStage: Gate 2 de TODAS las clases renderizadas de un job,
 * en paralelo (jueces) por pool de agentes.
 * ------------------------------------------------------------------ */

/** Resultado de Gate 2 para una lección dentro de `runGate2AllStage`. */
export interface Gate2AllLessonResult {
  lessonId: string;
  verdict?: string;
  error?: string;
}

/** Concurrencia del pool de jueces de Gate 2, vía GATE_CONCURRENCY (default 3). */
function resolveGate2Concurrency(): number {
  const concurrency = Number(process.env.GATE_CONCURRENCY ?? "3");
  return Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 3;
}

/**
 * Lista los lessonId que ya tienen `render/<lessonId>.mp4`, en el mismo
 * orden en que `fs.readdir` los devuelve (no hay estructure.json disponible
 * en este punto que dé un orden "canónico" más significativo).
 */
async function listRenderedLessonIds(jobId: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(renderDir(jobId));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => path.extname(entry) === ".mp4")
    .map((entry) => path.basename(entry, ".mp4"));
}

/**
 * Corre Gate 2 sobre TODAS las clases renderizadas de un job: primero la
 * etapa de frames (`runGate2FramesStage`) de cada lección EN SECUENCIA
 * (ffmpeg local, rápido: no vale la pena paralelizar procesos de ffmpeg acá),
 * y luego los jueces `/gate2-clase` de las lecciones cuyos frames se
 * generaron bien, EN PARALELO vía `runCommandsInPool` (concurrency
 * `GATE_CONCURRENCY`, default 3; modelo del rol `juez`).
 *
 * Una lección cuya etapa de frames falla no bloquea al resto: se reporta su
 * error en el resumen y no se le corre el juez. Lo mismo si el juez falla o
 * termina sin un veredicto válido en disco (ver `verifyGate2Outputs`).
 */
export async function runGate2AllStage(jobId: string): Promise<Gate2AllLessonResult[]> {
  const lessonIds = await listRenderedLessonIds(jobId);
  const resultsByLessonId = new Map<string, Gate2AllLessonResult>();

  // 1) Frames, en secuencia (ffmpeg local, rápido: correrlo en paralelo no
  // aporta y sí compite por I/O/CPU sin necesidad).
  for (const lessonId of lessonIds) {
    try {
      await runGate2FramesStage(jobId, lessonId);
    } catch (err) {
      resultsByLessonId.set(lessonId, {
        lessonId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2) Jueces /gate2-clase, en paralelo (pool), solo para las lecciones cuyos
  // frames se extrajeron bien.
  const pendingLessonIds = lessonIds.filter((lessonId) => !resultsByLessonId.has(lessonId));
  const poolResults = await runCommandsInPool(
    pendingLessonIds.map((lessonId) => ({
      command: "gate2-clase",
      args: `${jobId} ${lessonId}`,
      timeoutMin: resolveGate2TimeoutMin(),
      model: resolveModelForRole("juez"),
    })),
    resolveGate2Concurrency(),
  );

  for (let i = 0; i < pendingLessonIds.length; i += 1) {
    const lessonId = pendingLessonIds[i];
    const poolResult = poolResults[i];

    if (!poolResult.ok) {
      resultsByLessonId.set(lessonId, { lessonId, error: poolResult.error });
      continue;
    }

    try {
      await verifyGate2Outputs(jobId, lessonId);
      const verdict = (await readGate2Verdict(jobId, lessonId)) as { verdict?: string } | null;
      resultsByLessonId.set(lessonId, { lessonId, verdict: verdict?.verdict });
    } catch (err) {
      resultsByLessonId.set(lessonId, {
        lessonId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return lessonIds.map((lessonId) => resultsByLessonId.get(lessonId)!);
}
