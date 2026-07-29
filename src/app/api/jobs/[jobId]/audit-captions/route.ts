/**
 * POST /api/jobs/[jobId]/audit-captions — dispara la etapa 12 (auditoría de
 * subtítulos vía Claude Code) para un job que ya tiene `plan/captions/`
 * generado (etapa de captions, previa a esta).
 *
 * Fire-and-forget, mismo patrón que /api/jobs/[jobId]/prep: valida que el
 * job exista (404 si no) y que tenga al menos un `plan/captions/<lessonId>.json`
 * (400 si no), dispara `runCaptionsAuditStage` sin esperar a que termine, y
 * responde de inmediato. No exige ningún `job.status` específico más allá
 * del prerequisito real en disco (la auditoría de captions es independiente
 * del estado general del pipeline).
 *
 * Candado anti-duplicados (run-lock): 409 si esta etapa ya está corriendo
 * para este job.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { hasCaptionsToAudit, runCaptionsAuditStage } from "@/lib/captions-audit-stage";
import { release, tryAcquire } from "@/lib/run-lock";

export const runtime = "nodejs";

const STAGE = "audit-captions";

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

  if (!tryAcquire(jobId, STAGE)) {
    return NextResponse.json(
      { error: "Esta etapa ya está corriendo" },
      { status: 409 }
    );
  }

  let started = false;
  try {
    if (!(await hasCaptionsToAudit(jobId))) {
      return NextResponse.json(
        {
          error:
            "No se puede auditar subtítulos: el proyecto no tiene 'plan/captions/' con al menos un archivo generado.",
        },
        { status: 400 }
      );
    }

    started = true;
    // Fire-and-forget: no se espera a que termine la auditoría para responder.
    runCaptionsAuditStage(jobId)
      .catch(console.error)
      .finally(() => release(jobId, STAGE));

    return NextResponse.json({ ok: true });
  } finally {
    if (!started) release(jobId, STAGE);
  }
}
