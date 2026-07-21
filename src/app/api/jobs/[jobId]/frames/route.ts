/**
 * POST /api/jobs/[jobId]/frames — re-corre (o corre por primera vez) solo la
 * etapa de muestreo de frames de un job ya transcrito, sin volver a probar
 * ni re-transcribir.
 *
 * Valida que el job exista (404 si no), que su status permita muestrear
 * frames (400 si todavía no fue transcrito), y que no haya ya un pipeline
 * corriendo en memoria para ese job (409 si lo hay). La validación de status
 * se hace acá mismo — sincrónica respecto al request — porque
 * `runFramesOnly` valida el status de forma asíncrona (adentro de su propia
 * promesa) y queremos poder responder 400 antes de disparar el
 * fire-and-forget, no dejar que el error quede solo registrado en
 * job.json.errorMessage.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { isPipelineRunning, runFramesOnly } from "@/lib/pipeline";
import type { JobStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Estados desde los que tiene sentido (re)correr el muestreo de frames. */
const FRAMES_READY_STATUSES: JobStatus[] = [
  "transcribed",
  "sampling",
  "sampled",
];

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  let job;
  try {
    job = await readJobJson(jobId);
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

  if (!FRAMES_READY_STATUSES.includes(job.status)) {
    return NextResponse.json(
      {
        error: `No se puede muestrear frames: el proyecto debe estar transcrito primero (status actual: "${job.status}")`,
      },
      { status: 400 }
    );
  }

  // Fire-and-forget: no se espera a que termine el muestreo para responder.
  runFramesOnly(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
