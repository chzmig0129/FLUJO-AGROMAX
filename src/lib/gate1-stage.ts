/**
 * gate1-stage.ts — etapa "Gate 1" del diseño: inspección de cada overlay
 * (PNG) generado antes de usarse, vía el comando headless `/gate1-overlays`
 * de Claude Code (suscripción, con visión: el CLI lee los composites
 * `.jpg` con Read), usando el motor genérico de `plan/claude-code-engine.ts`.
 *
 * Prerequisito real: `qa/gate1-chk/<key>.jpg` (composites sobre gris
 * oscuro) ya existen — los produce el worker paralelo (no se documenta acá
 * a propósito, ver contrato del issue) antes de correr esta etapa.
 * Dispara el comando, y verifica en disco que produjo un veredicto real y
 * válido en `qa/gate1.json` — el CLI puede salir con código 0 sin haber
 * completado el trabajo real, igual que las demás etapas que delegan en
 * `claude-code-engine.ts`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommandViaClaudeCode } from "./plan/claude-code-engine";
import { jobPath } from "./jobs";

/** Veredictos aceptados por imagen dentro de `qa/gate1.json`. */
const VALID_IMAGE_VERDICTS = new Set(["APPROVED", "REJECTED"]);

/** Forma mínima esperada del veredicto de Gate 1 para poder verificarlo en disco. */
interface Gate1VerdictShape {
  auditedAt?: string;
  images?: Array<{ key?: string; verdict?: string }>;
}

/** Timeout máximo (en minutos) para la corrida completa del comando /gate1-overlays. */
function resolveGate1TimeoutMin(): number {
  const minutes = Number(process.env.GATE1_TIMEOUT_MIN ?? "25");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 25;
}

/** Ruta absoluta al directorio de composites de chequeo de Gate 1. */
function gate1ChkDir(jobId: string): string {
  return path.join(jobPath(jobId), "qa", "gate1-chk");
}

/** Ruta absoluta al veredicto de Gate 1 del job. */
function gate1VerdictPath(jobId: string): string {
  return path.join(jobPath(jobId), "qa", "gate1.json");
}

/**
 * Verifica (tolerante) si el job tiene al menos un composite de chequeo en
 * `qa/gate1-chk/*.jpg` — el prerequisito real para correr el juez.
 */
export async function hasGate1Composites(jobId: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(gate1ChkDir(jobId));
  } catch {
    return false;
  }
  return entries.some((name) => name.toLowerCase().endsWith(".jpg"));
}

/**
 * Corre la etapa Gate 1 invocando `/gate1-overlays <jobId>` vía
 * `runCommandViaClaudeCode`, y luego verifica en disco que la corrida
 * produjo `qa/gate1.json` con un veredicto válido y parseable.
 */
export async function runGate1Stage(jobId: string): Promise<void> {
  const ok = await hasGate1Composites(jobId);
  if (!ok) {
    throw new Error(
      `No se puede correr Gate 1: el job '${jobId}' no tiene ningún composite en 'qa/gate1-chk/*.jpg' (falta correr la etapa de generación de overlays primero).`,
    );
  }

  await runCommandViaClaudeCode({
    command: "gate1-overlays",
    args: jobId,
    timeoutMin: resolveGate1TimeoutMin(),
  });

  await verifyGate1Outputs(jobId);
}

/**
 * Verifica que la corrida haya producido un veredicto real y parseable de
 * Gate 1, porque el CLI puede terminar con exit code 0 sin haber escrito
 * nada (ej. si se detuvo antes de completar la auditoría visual).
 */
async function verifyGate1Outputs(jobId: string): Promise<void> {
  const verdictPath = gate1VerdictPath(jobId);

  let verdict: Gate1VerdictShape | null = null;
  try {
    const raw = await fs.readFile(verdictPath, "utf-8");
    verdict = JSON.parse(raw) as Gate1VerdictShape;
  } catch {
    verdict = null;
  }

  const images = verdict?.images;
  const isValid =
    verdict !== null &&
    Array.isArray(images) &&
    images.length > 0 &&
    images.every(
      (image) =>
        typeof image.key === "string" &&
        image.key.length > 0 &&
        VALID_IMAGE_VERDICTS.has(image.verdict ?? ""),
    );

  if (!isValid) {
    throw new Error(
      `La etapa Gate 1 (claude-code) terminó sin generar un veredicto válido en '${verdictPath}' para el job '${jobId}'. El comando /gate1-overlays no completó su trabajo.`,
    );
  }
}
