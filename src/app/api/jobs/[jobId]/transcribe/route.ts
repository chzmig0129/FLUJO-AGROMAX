/**
 * POST /api/jobs/[jobId]/transcribe — re-corre el pipeline (probe +
 * transcripción) para un job ya existente, sin necesidad de re-ingerir.
 *
 * Valida que el job exista (404 si no), y que no haya ya un pipeline
 * corriendo para ese job en memoria (409 si lo hay). Si todo está OK,
 * dispara runPipeline sin await (fire-and-forget) y responde de inmediato.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { isPipelineRunning, runPipeline } from "@/lib/pipeline";

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

  // Fire-and-forget: no se espera a que termine el pipeline para responder.
  runPipeline(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
