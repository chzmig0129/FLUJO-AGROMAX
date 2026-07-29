/**
 * POST /api/jobs/[jobId]/overlay-briefs — dispara la etapa 7 (briefs de
 * overlays didácticos vía Claude Code) para un job que ya tiene
 * `plan/structure.json` y `transcripts/` generados.
 *
 * Fire-and-forget, mismo patrón que /api/jobs/[jobId]/prep y
 * /api/jobs/[jobId]/audit-captions: valida que el job exista (404 si no) y
 * que tenga los prerequisitos reales en disco (400 si no), dispara
 * `runOverlayBriefsStage` sin esperar a que termine, y responde de
 * inmediato. No exige ningún `job.status` específico más allá de esos
 * prerequisitos.
 *
 * Candado anti-duplicados (run-lock): si esta etapa ya está corriendo para
 * este job (por ejemplo, doble click en "Generar briefs" antes de que el
 * primer disparo termine), responde 409 sin arrancar una segunda corrida de
 * `claude` concurrente sobre el mismo job.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { hasOverlayBriefsPrerequisites, runOverlayBriefsStage } from "@/lib/overlay-briefs-stage";
import { release, tryAcquire } from "@/lib/run-lock";

export const runtime = "nodejs";

const STAGE = "overlay-briefs";

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
    if (!(await hasOverlayBriefsPrerequisites(jobId))) {
      return NextResponse.json(
        {
          error:
            "No se pueden generar briefs de overlays: el proyecto no tiene 'plan/structure.json' y/o 'transcripts/' con al menos un archivo generado.",
        },
        { status: 400 }
      );
    }

    started = true;
    // Fire-and-forget: no se espera a que termine la generación de briefs para responder.
    runOverlayBriefsStage(jobId)
      .catch(console.error)
      .finally(() => release(jobId, STAGE));

    return NextResponse.json({ ok: true });
  } finally {
    if (!started) release(jobId, STAGE);
  }
}
