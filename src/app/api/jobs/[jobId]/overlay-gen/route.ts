/**
 * POST /api/jobs/[jobId]/overlay-gen — dispara la etapa 8a (generación de
 * overlays: scraper CDP + flood-fill/trim/sombra + composite de chequeo del
 * Gate 1) para un job que ya tiene al menos un brief en
 * `plan/overlays/<lessonId>.json` (etapa 7).
 *
 * Fire-and-forget, mismo patrón que /api/jobs/[jobId]/overlay-briefs y
 * /api/jobs/[jobId]/prep: valida que el job exista (404 si no) y que tenga
 * el prerequisito real en disco (400 si no), dispara
 * `runOverlayGenStage` sin esperar a que termine, y responde de inmediato.
 *
 * Candado anti-duplicados (run-lock): 409 si esta etapa ya está corriendo
 * para este job.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { hasOverlayGenPrerequisites, runOverlayGenStage } from "@/lib/overlay-gen-stage";
import { release, tryAcquire } from "@/lib/run-lock";

export const runtime = "nodejs";

const STAGE = "overlay-gen";

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
    if (!(await hasOverlayGenPrerequisites(jobId))) {
      return NextResponse.json(
        {
          error:
            "No se pueden generar overlays: el proyecto no tiene ningún brief en 'plan/overlays/*.json' (falta correr la etapa de briefs de overlays primero, o el curso no tiene overlays que generar).",
        },
        { status: 400 }
      );
    }

    started = true;
    // Fire-and-forget: no se espera a que termine la generación de overlays para responder.
    runOverlayGenStage(jobId)
      .catch(console.error)
      .finally(() => release(jobId, STAGE));

    return NextResponse.json({ ok: true });
  } finally {
    if (!started) release(jobId, STAGE);
  }
}
