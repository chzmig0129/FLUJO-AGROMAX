/**
 * POST /api/jobs/[jobId]/overlays-timeline — dispara la etapa post-Gate 1
 * (remapeo de overlays didácticos al timeline de salida, ver
 * overlays-timeline-stage.ts) para un job que ya tiene `plan/cuts/` y
 * `plan/overlays/` generados.
 *
 * Fire-and-forget, mismo patrón que /api/jobs/[jobId]/overlay-briefs y
 * /api/jobs/[jobId]/audit-captions: valida que el job exista (404 si no) y
 * que tenga los prerequisitos reales en disco (400 si no: sin briefs o sin
 * cuts), dispara `runOverlaysTimelineStage` sin esperar a que termine, y
 * responde de inmediato.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import {
  hasOverlaysTimelinePrerequisites,
  runOverlaysTimelineStage,
} from "@/lib/overlays-timeline-stage";

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

  if (!(await hasOverlaysTimelinePrerequisites(jobId))) {
    return NextResponse.json(
      {
        error:
          "No se puede generar el timeline de overlays: el proyecto no tiene 'plan/cuts/' y/o 'plan/overlays/' con al menos un archivo generado.",
      },
      { status: 400 }
    );
  }

  // Fire-and-forget: no se espera a que termine el remapeo para responder.
  runOverlaysTimelineStage(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
