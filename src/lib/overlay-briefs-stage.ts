/**
 * overlay-briefs-stage.ts — etapa 7 del diseño: briefs de overlays
 * didácticos vía el comando headless `/briefs-overlays` de Claude Code
 * (suscripción), usando el motor genérico de `plan/claude-code-engine.ts`.
 *
 * Valida que el job tenga `plan/structure.json` y `transcripts/` con al
 * menos un archivo `.json` (prerequisitos reales: la etapa de plan y la de
 * transcripción ya corrieron), dispara el comando, y verifica en disco que
 * produjo `plan/overlays/<lessonId>.json` parseable para CADA lección de la
 * estructura — el CLI puede salir con código 0 sin haber completado el
 * trabajo real, igual que la etapa de plan (ver `verifyPlanOutputs` en
 * claude-code-engine.ts) y que la auditoría de captions
 * (`verifyCaptionsAuditOutputs` en captions-audit-stage.ts).
 *
 * 0 briefs en una lección es un resultado válido (ver
 * `.claude/commands/briefs-overlays.md`, regla central): lo que NO es
 * válido es que falte el archivo de la lección por completo.
 *
 * No toca `plan/structure.json` ni `transcripts/`: esos son solo lectura
 * para la propia sesión de Claude Code que corre el comando
 * `/briefs-overlays` (ver `.claude/commands/briefs-overlays.md`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommandViaClaudeCode } from "./plan/claude-code-engine";
import { planDir, readStructureJson, structureJsonPath, transcriptsDir } from "./jobs";

/** Timeout máximo (en minutos) para la corrida completa del comando /briefs-overlays. */
function resolveOverlayBriefsTimeoutMin(): number {
  const minutes = Number(process.env.OVERLAY_BRIEFS_TIMEOUT_MIN ?? "30");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
}

/** Ruta absoluta al subdirectorio plan/overlays/ de un job. */
function overlaysDirPath(jobId: string): string {
  return path.join(planDir(jobId), "overlays");
}

/** Ruta absoluta a plan/overlays/<lessonId>.json de un job. */
function overlaysJsonPath(jobId: string, lessonId: string): string {
  return path.join(overlaysDirPath(jobId), `${lessonId}.json`);
}

/**
 * Verifica (tolerante) si el job tiene `plan/structure.json` y
 * `transcripts/` con al menos un archivo `.json` — los dos prerequisitos
 * reales de la etapa 7. Se usa tanto acá (guard previo a disparar el
 * comando) como desde la ruta HTTP (para responder 400 sin encolar nada).
 */
export async function hasOverlayBriefsPrerequisites(jobId: string): Promise<boolean> {
  try {
    await fs.access(structureJsonPath(jobId));
  } catch {
    return false;
  }

  let entries: string[];
  try {
    entries = await fs.readdir(transcriptsDir(jobId));
  } catch {
    return false;
  }
  return entries.some((entry) => entry.endsWith(".json"));
}

/**
 * Corre la etapa de briefs de overlays invocando
 * `/briefs-overlays <jobId>` vía `runCommandViaClaudeCode`, y luego
 * verifica en disco que la corrida produjo un `plan/overlays/<lessonId>.json`
 * válido para cada lección de `plan/structure.json`.
 */
export async function runOverlayBriefsStage(jobId: string): Promise<void> {
  const ok = await hasOverlayBriefsPrerequisites(jobId);
  if (!ok) {
    throw new Error(
      `No se pueden generar briefs de overlays: el job '${jobId}' no tiene 'plan/structure.json' y/o 'transcripts/' con al menos un archivo .json (falta correr la etapa de plan y/o de transcripción primero).`,
    );
  }

  await runCommandViaClaudeCode({
    command: "briefs-overlays",
    args: jobId,
    timeoutMin: resolveOverlayBriefsTimeoutMin(),
  });

  await verifyOverlayBriefsOutputs(jobId);
}

/**
 * Verifica que la corrida haya producido, para CADA lección de
 * `plan/structure.json`, un `plan/overlays/<lessonId>.json` real y
 * parseable con forma `{lessonId, generatedAt, briefs: [...]}` — 0 briefs
 * es válido, lo que no es válido es que falte el archivo o que sea
 * inválido/no parseable.
 */
async function verifyOverlayBriefsOutputs(jobId: string): Promise<void> {
  const structure = await readStructureJson(jobId);
  if (!structure) {
    throw new Error(
      `La etapa de briefs de overlays (claude-code) no pudo verificarse para el job '${jobId}': 'plan/structure.json' ya no existe.`,
    );
  }

  const lessonIds = structure.modules.flatMap((mod) => mod.lessons.map((lesson) => lesson.id));

  if (lessonIds.length === 0) {
    throw new Error(
      `La etapa de briefs de overlays (claude-code) no pudo verificarse para el job '${jobId}': 'plan/structure.json' no tiene lecciones.`,
    );
  }

  for (const lessonId of lessonIds) {
    const filePath = overlaysJsonPath(jobId, lessonId);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      throw new Error(
        `La etapa de briefs de overlays (claude-code) terminó sin generar plan/overlays/${lessonId}.json para el job '${jobId}'. El comando /briefs-overlays no completó su trabajo.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `La etapa de briefs de overlays (claude-code) generó plan/overlays/${lessonId}.json inválido para el job '${jobId}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { briefs?: unknown }).briefs)
    ) {
      throw new Error(
        `La etapa de briefs de overlays (claude-code) generó plan/overlays/${lessonId}.json con forma inválida para el job '${jobId}': falta el arreglo 'briefs'.`,
      );
    }
  }
}
