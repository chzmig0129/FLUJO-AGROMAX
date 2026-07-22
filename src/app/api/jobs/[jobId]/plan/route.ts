/**
 * POST /api/jobs/[jobId]/plan — re-corre (o corre por primera vez) solo la
 * etapa de plan (filtro editorial y estructura autónoma vía agente Claude)
 * de un job ya muestreado, sin volver a probar, transcribir ni re-muestrear
 * frames.
 *
 * Valida que el job exista (404 si no), que su status permita planear (400
 * si todavía no fue muestreado), y que no haya ya un pipeline corriendo en
 * memoria para ese job (409 si lo hay). La validación de status se hace acá
 * mismo — sincrónica respecto al request — porque `runPlanOnly` valida el
 * status de forma asíncrona (adentro de su propia promesa) y queremos poder
 * responder 400 antes de disparar el fire-and-forget, no dejar que el error
 * quede solo registrado en job.json.errorMessage.
 *
 * También acepta jobs en status 'error' siempre que ya tengan los
 * prerequisitos reales del plan en disco (transcripts/summary.json y
 * frames/manifest.json) — esto permite reintentar solo el plan (por ejemplo
 * tras configurar ANTHROPIC_API_KEY) sin re-transcribir todo el material. Si
 * el job está en 'error' pero le faltan esos prerequisitos, la falla ocurrió
 * antes del plan y se responde 400 con un mensaje claro pidiendo reintentar
 * el pipeline completo.
 *
 * Si el body trae `{ force: true }` y el job ya tiene esos mismos
 * prerequisitos, se permite el re-plan desde CUALQUIER status (no solo
 * 'error') mientras no haya un pipeline corriendo para ese job — por
 * ejemplo un job en 'assembling' al que se le borraron los renders y hace
 * falta re-planear sin re-transcribir ni re-muestrear.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import {
  hasPlanPrerequisites,
  isPipelineRunning,
  runPlanOnly,
} from "@/lib/pipeline";
import type { JobStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Estados desde los que tiene sentido (re)correr la etapa de plan. */
const PLAN_READY_STATUSES: JobStatus[] = ["sampled", "planning", "planned"];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  let force = false;
  try {
    const body = await request.json();
    force = body?.force === true;
  } catch {
    // Body ausente o no-JSON: se trata como force:false (comportamiento
    // previo, sin body).
    force = false;
  }

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

  if (!PLAN_READY_STATUSES.includes(job.status)) {
    const hasPrereqs = await hasPlanPrerequisites(jobId);

    if (job.status === "error" && hasPrereqs) {
      // El job falló en (o después de) la etapa de plan, pero ya tiene los
      // prerequisitos reales (transcripción + muestreo de frames): se puede
      // reintentar solo el plan sin re-transcribir.
      runPlanOnly(jobId, { force }).catch(console.error);
      return NextResponse.json({ ok: true });
    }

    if (force && hasPrereqs) {
      // Re-plan forzado desde cualquier status (ej. 'assembling' con los
      // renders borrados): ya hay prerequisitos reales en disco y no hay
      // pipeline corriendo (chequeado arriba), así que es seguro re-planear.
      runPlanOnly(jobId, { force }).catch(console.error);
      return NextResponse.json({ ok: true });
    }

    const message =
      job.status === "error"
        ? `No se puede reintentar solo el plan: el proyecto falló antes de completar el muestreo de frames (status actual: "${job.status}"). Reintenta el pipeline completo.`
        : `No se puede planear: el proyecto debe estar muestreado primero (status actual: "${job.status}")`;

    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Fire-and-forget: no se espera a que termine el plan para responder.
  runPlanOnly(jobId, { force }).catch(console.error);

  return NextResponse.json({ ok: true });
}
