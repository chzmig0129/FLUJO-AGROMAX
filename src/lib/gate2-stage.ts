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
import { runCommandViaClaudeCode } from "./plan/claude-code-engine";
import { jobPath, gate2VerdictPath, readGate2Verdict } from "./jobs";

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
