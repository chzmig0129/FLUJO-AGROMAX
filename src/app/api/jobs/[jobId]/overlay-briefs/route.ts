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
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { hasOverlayBriefsPrerequisites, runOverlayBriefsStage } from "@/lib/overlay-briefs-stage";

export const runtime = "nodejs";

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

  if (!(await hasOverlayBriefsPrerequisites(jobId))) {
    return NextResponse.json(
      {
        error:
          "No se pueden generar briefs de overlays: el proyecto no tiene 'plan/structure.json' y/o 'transcripts/' con al menos un archivo generado.",
      },
      { status: 400 }
    );
  }

  // Fire-and-forget: no se espera a que termine la generación de briefs para responder.
  runOverlayBriefsStage(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
