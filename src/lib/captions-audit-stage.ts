/**
 * captions-audit-stage.ts — etapa 12 del diseño: auditoría de subtítulos
 * (captions) vía el comando headless `/auditar-subtitulos` de Claude Code
 * (suscripción), usando el motor genérico de `plan/claude-code-engine.ts`.
 *
 * Valida que el job tenga `plan/captions/` con al menos un archivo `.json`
 * (prerequisito real: la etapa de captions ya corrió), dispara el comando, y
 * verifica en disco que produjo `plan/captions-audit.json` — el CLI puede
 * salir con código 0 sin haber completado el trabajo real, igual que la
 * etapa de plan (ver `verifyPlanOutputs` en claude-code-engine.ts).
 *
 * No toca `plan/captions/<lessonId>.json` directamente: esos archivos los
 * corrige in-place la propia sesión de Claude Code que corre el comando
 * `/auditar-subtitulos` (ver `.claude/commands/auditar-subtitulos.md`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommandViaClaudeCode } from "./plan/claude-code-engine";
import { planDir } from "./jobs";

/** Timeout máximo (en minutos) para la corrida completa del comando /auditar-subtitulos. */
function resolveCaptionsAuditTimeoutMin(): number {
  const minutes = Number(process.env.CAPTIONS_AUDIT_TIMEOUT_MIN ?? "30");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
}

/** Ruta absoluta al subdirectorio plan/captions/ de un job. */
function captionsDirPath(jobId: string): string {
  return path.join(planDir(jobId), "captions");
}

/** Ruta absoluta a plan/captions-audit.json de un job. */
function captionsAuditJsonPath(jobId: string): string {
  return path.join(planDir(jobId), "captions-audit.json");
}

/**
 * Verifica (tolerante) si `plan/captions/` existe y tiene al menos un
 * archivo `.json`. Se usa tanto acá (guard previo a disparar el comando)
 * como desde la ruta HTTP (para responder 400 sin encolar nada).
 */
export async function hasCaptionsToAudit(jobId: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(captionsDirPath(jobId));
  } catch {
    return false;
  }
  return entries.some((entry) => entry.endsWith(".json"));
}

/**
 * Corre la etapa de auditoría de captions invocando
 * `/auditar-subtitulos <jobId>` vía `runCommandViaClaudeCode`, y luego
 * verifica en disco que la corrida produjo `plan/captions-audit.json`
 * válido.
 */
export async function runCaptionsAuditStage(jobId: string): Promise<void> {
  const ok = await hasCaptionsToAudit(jobId);
  if (!ok) {
    throw new Error(
      `No se puede auditar subtítulos: el job '${jobId}' no tiene 'plan/captions/' con al menos un archivo .json (falta correr la etapa de captions primero).`,
    );
  }

  await runCommandViaClaudeCode({
    command: "auditar-subtitulos",
    args: jobId,
    timeoutMin: resolveCaptionsAuditTimeoutMin(),
  });

  await verifyCaptionsAuditOutputs(jobId);
}

/**
 * Verifica que la corrida haya producido `plan/captions-audit.json` real y
 * parseable, porque el CLI puede terminar con exit code 0 sin haber escrito
 * nada (ej. si se detuvo antes de completar la auditoría).
 */
async function verifyCaptionsAuditOutputs(jobId: string): Promise<void> {
  const auditPath = captionsAuditJsonPath(jobId);

  let raw: string;
  try {
    raw = await fs.readFile(auditPath, "utf-8");
  } catch {
    throw new Error(
      `La etapa de auditoría de subtítulos (claude-code) terminó sin generar plan/captions-audit.json para el job '${jobId}'. El comando /auditar-subtitulos no completó su trabajo.`,
    );
  }

  try {
    JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `La etapa de auditoría de subtítulos (claude-code) generó plan/captions-audit.json inválido para el job '${jobId}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
