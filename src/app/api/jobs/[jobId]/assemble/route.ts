/**
 * POST /api/jobs/[jobId]/assemble — corre (o re-corre) las etapas 9 (intros)
 * y 11 (ensamblaje headless) de un job ya preparado, produciendo
 * render/<lessonId>.mp4 por clase.
 *
 * Mismo patrón que /prep: valida sincrónicamente (404 si el job no existe,
 * 409 si ya hay una corrida en curso, 400 si todavía no está preparado) y
 * después dispara el trabajo fire-and-forget. La UI sigue el avance
 * polleando progress/assembly-progress.json vía GET /api/jobs/[jobId].
 *
 * Body opcional: { "force": true } re-renderiza todas las clases aunque ya
 * tengan un render verificado y vigente.
 *
 * NO recibe ni elige backend: el backend sale de ASSEMBLY_BACKEND (ver
 * lib/assembly/index.ts). Esta ruta no sabe si detrás corre Remotion.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import {
  hasAssemblyPrerequisites,
  isPipelineRunning,
  runAssembleOnly,
} from "@/lib/pipeline";
import type { JobStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Estados desde los que tiene sentido (re)correr el ensamblaje. */
const ASSEMBLY_READY_STATUSES: JobStatus[] = [
  "prepared",
  "assembling",
  "assembled",
];

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

  // El body es opcional: un POST sin cuerpo equivale a { force: false }.
  let force = false;
  try {
    const body = (await request.json()) as { force?: boolean } | null;
    force = Boolean(body?.force);
  } catch {
    force = false;
  }

  if (!ASSEMBLY_READY_STATUSES.includes(job.status)) {
    // Un job en 'error' puede reintentar solo el ensamblaje si los cortes ya
    // están en disco: la falla fue en (o después de) esta etapa.
    if (job.status === "error" && (await hasAssemblyPrerequisites(jobId))) {
      runAssembleOnly(jobId, { force }).catch(console.error);
      return NextResponse.json({ ok: true });
    }

    const message =
      job.status === "error"
        ? `No se puede reintentar solo el ensamblaje: el proyecto falló antes de completar la preparación (status actual: "${job.status}"). Reintenta la preparación.`
        : `No se puede ensamblar: el proyecto debe estar preparado primero (status actual: "${job.status}")`;

    return NextResponse.json({ error: message }, { status: 400 });
  }

  runAssembleOnly(jobId, { force }).catch(console.error);

  return NextResponse.json({ ok: true });
}
