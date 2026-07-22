/**
 * POST /api/jobs/[jobId]/prep — re-corre (o corre por primera vez) las
 * etapas deterministas de preparación (5A silencio, 5B proxies, 5C cortes)
 * de un job ya planeado, sin volver a probar, transcribir, re-muestrear
 * frames ni re-planear.
 *
 * Valida que el job exista (404 si no), que su `status` permita preparar
 * (400 si todavía no fue planeado), y que no haya ya un pipeline corriendo
 * en memoria para ese job (409 si lo hay). La validación de status se hace
 * acá mismo — sincrónica respecto al request — porque `runPrepOnly` valida
 * el status de forma asíncrona (adentro de su propia promesa) y queremos
 * poder responder 400 antes de disparar el fire-and-forget, no dejar que el
 * error quede solo registrado en job.json.errorMessage.
 *
 * También acepta jobs en status 'error' siempre que ya tengan el
 * prerequisito real de la preparación en disco (plan/structure.json) — esto
 * permite reintentar solo la preparación (por ejemplo tras un fallo puntual
 * de ffmpeg) sin re-planear todo el curso. Si el job está en 'error' pero le
 * falta ese prerequisito, la falla ocurrió antes de la preparación y se
 * responde 400 con un mensaje claro pidiendo reintentar el pipeline
 * completo (o al menos el plan).
 *
 * Gate de aprobación humana (etapa 6): antes de disparar la preparación se
 * exige que plan/approval.json exista (la estructura fue aprobada tal como
 * está en disco); si no existe y el body no trae force:true, responde 409.
 * El body es opcional y tolerante: si falta o no es JSON válido, se trata
 * como {} (equivalente a no pasar force).
 */
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { readApprovalJson, readJobJson, structureJsonPath } from "@/lib/jobs";
import { isPipelineRunning, runPrepOnly } from "@/lib/pipeline";
import type { JobStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Estados desde los que tiene sentido (re)correr las etapas de preparación. */
const PREP_READY_STATUSES: JobStatus[] = ["planned", "preparing", "prepared"];

/** Verifica (tolerante) si plan/structure.json ya existe en disco. */
async function hasPrepPrerequisites(jobId: string): Promise<boolean> {
  try {
    await fs.access(structureJsonPath(jobId));
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

  // El body es opcional y tolerante: si falta o no es JSON válido, se trata
  // como {} (equivalente a no pasar force:true ni lessonId).
  let body: { force?: boolean; lessonId?: string } = {};
  try {
    const parsed = await request.json();
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as { force?: boolean; lessonId?: string };
    }
  } catch {
    // Body ausente o inválido: se mantiene {} (sin force ni lessonId).
  }

  if (body.force !== true) {
    const approval = await readApprovalJson(jobId);
    if (!approval) {
      return NextResponse.json(
        {
          error:
            "La estructura no está aprobada. Aprueba en la UI o envía force:true.",
        },
        { status: 409 }
      );
    }
  }

  if (!PREP_READY_STATUSES.includes(job.status)) {
    if (job.status === "error" && (await hasPrepPrerequisites(jobId))) {
      // El job falló en (o después de) la preparación, pero ya tiene el
      // prerequisito real (plan/structure.json): se puede reintentar solo
      // la preparación sin re-planear.
      runPrepOnly(jobId, { force: body.force, lessonId: body.lessonId }).catch(
        console.error
      );
      return NextResponse.json({ ok: true });
    }

    const message =
      job.status === "error"
        ? `No se puede reintentar solo la preparación: el proyecto falló antes de completar el plan (status actual: "${job.status}"). Reintenta el pipeline completo (o al menos el plan).`
        : `No se puede preparar: el proyecto debe estar planeado primero (status actual: "${job.status}")`;

    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Fire-and-forget: no se espera a que termine la preparación para responder.
  runPrepOnly(jobId, { force: body.force, lessonId: body.lessonId }).catch(
    console.error
  );

  return NextResponse.json({ ok: true });
}
