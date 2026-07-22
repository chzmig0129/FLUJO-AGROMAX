/**
 * POST /api/jobs/[jobId]/run-all — dispara el modo "corre todo solo": el
 * pipeline completo desatendido (`runFullPipeline`, ver `@/lib/pipeline`)
 * que encadena, sobre un job ya aprobado (o con AUTO_APPROVE), prep ->
 * audit-captions -> overlay-briefs -> overlay-gen (si CDP disponible) ->
 * gate1 -> overlays-timeline -> assemble -> gate2-all -> (director si hay
 * rechazos) -> gate3 por módulo -> package, hasta dejar la entrega en
 * `deliver/`.
 *
 * Mismo patrón que `/api/jobs/[jobId]/prep`: valida sincrónicamente (404 si
 * el job no existe, 409 si ya hay una corrida en curso, 400 si la
 * estructura no está aprobada y AUTO_APPROVE no está habilitado) y después
 * dispara el trabajo fire-and-forget. La UI sigue el avance polleando
 * GET /api/jobs/[jobId] (mismo status/errorMessage que el resto del
 * pipeline).
 */
import { NextResponse } from "next/server";
import { readApprovalJson, readJobJson } from "@/lib/jobs";
import {
  isAutoApproveEnabled,
  isPipelineRunning,
  runFullPipeline,
} from "@/lib/pipeline";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
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

  if (isPipelineRunning(jobId)) {
    return NextResponse.json(
      { error: "El proyecto ya se está procesando" },
      { status: 409 }
    );
  }

  if (!isAutoApproveEnabled()) {
    const approval = await readApprovalJson(jobId);
    if (!approval) {
      return NextResponse.json(
        {
          error:
            "No se puede correr el pipeline completo: la estructura no está aprobada. Aprueba en la UI o define AUTO_APPROVE.",
        },
        { status: 400 }
      );
    }
  }

  // Fire-and-forget: no se espera a que termine la corrida completa para
  // responder.
  runFullPipeline(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
