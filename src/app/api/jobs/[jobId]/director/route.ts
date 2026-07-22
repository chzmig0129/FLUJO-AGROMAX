/**
 * POST /api/jobs/[jobId]/director — dispara el "director de edición": el
 * loop de corrección automática que lee todos los veredictos de QA del job
 * (Gate 1, Gate 2, Gate 3, auditoría de subtítulos) y decide/ejecuta los
 * fixes, vía Claude Code (`runDirectorStage`, `director-stage.ts`, comando
 * `/director-edicion`).
 *
 * Fire-and-forget, mismo patrón que `/api/jobs/[jobId]/gate2` y `/gate3`:
 * valida que el job exista (404 si no) y que haya al menos algún veredicto
 * de QA ya escrito en disco (`qa/gate1.json`, `qa/gate2/<lessonId>.json`,
 * `qa/gate3/<moduleId>.json` o `plan/captions-audit.json`) — sin eso no hay
 * nada que el director pueda dirigir (400 si ninguno existe). Dispara
 * `runDirectorStage` sin esperar a que termine, y responde de inmediato.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { readJobJson, qaDir, planDir } from "@/lib/jobs";
import { runDirectorStage } from "@/lib/director-stage";

export const runtime = "nodejs";

/** Verifica (tolerante) si `qa/gate1.json` existe. */
async function hasGate1Verdict(jobId: string): Promise<boolean> {
  try {
    await fs.access(path.join(qaDir(jobId), "gate1.json"));
    return true;
  } catch {
    return false;
  }
}

/** Verifica (tolerante) si `qa/gate2/` existe y tiene al menos un archivo `.json`. */
async function hasGate2Verdicts(jobId: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(qaDir(jobId), "gate2"));
  } catch {
    return false;
  }
  return entries.some((entry) => entry.endsWith(".json"));
}

/** Verifica (tolerante) si `qa/gate3/` existe y tiene al menos un archivo `.json`. */
async function hasGate3Verdicts(jobId: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(qaDir(jobId), "gate3"));
  } catch {
    return false;
  }
  return entries.some((entry) => entry.endsWith(".json"));
}

/** Verifica (tolerante) si `plan/captions-audit.json` existe. */
async function hasCaptionsAuditVerdict(jobId: string): Promise<boolean> {
  try {
    await fs.access(path.join(planDir(jobId), "captions-audit.json"));
    return true;
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    await readJobJson(jobId);
  } catch {
    return NextResponse.json(
      { error: "Proyecto no encontrado" },
      { status: 404 }
    );
  }

  const [gate1Ok, gate2Ok, gate3Ok, captionsAuditOk] = await Promise.all([
    hasGate1Verdict(jobId),
    hasGate2Verdicts(jobId),
    hasGate3Verdicts(jobId),
    hasCaptionsAuditVerdict(jobId),
  ]);

  if (!gate1Ok && !gate2Ok && !gate3Ok && !captionsAuditOk) {
    return NextResponse.json(
      {
        error:
          "No se puede correr el director de edición: el proyecto todavía no tiene ningún veredicto de QA ('qa/gate1.json', 'qa/gate2/<lessonId>.json', 'qa/gate3/<moduleId>.json' ni 'plan/captions-audit.json') que dirigir (falta correr al menos un gate primero).",
      },
      { status: 400 }
    );
  }

  // Fire-and-forget: no se espera a que termine el loop del director para responder.
  runDirectorStage(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
