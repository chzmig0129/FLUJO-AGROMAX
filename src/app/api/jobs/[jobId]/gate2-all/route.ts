/**
 * POST /api/jobs/[jobId]/gate2-all — corre el "Gate 2" de QA visual sobre
 * TODAS las clases renderizadas de un job, en vez de una sola (a diferencia
 * de `/api/jobs/[jobId]/gate2`, que exige `lessonId` en el body): primero la
 * etapa de frames de cada lección en secuencia, y luego los jueces
 * `/gate2-clase` de todas en paralelo (pool) — ver `runGate2AllStage` en
 * `@/lib/gate2-stage`.
 *
 * 404 si el job no existe. Sin body requerido (a diferencia de `/gate2`): no
 * hay `lessonId` que validar, la etapa arma la lista de lecciones a auditar
 * ella misma a partir de `render/*.mp4`. Fire-and-forget: no se espera a que
 * termine el gate completo (todas las clases) para responder, mismo patrón
 * que `/api/jobs/[jobId]/prep` y `/api/jobs/[jobId]/gate2`.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { runGate2AllStage } from "@/lib/gate2-stage";

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

  // Fire-and-forget: no se espera a que termine Gate 2 de todas las clases
  // para responder. El resumen (veredicto/error por lección) queda en el log
  // del servidor; los veredictos individuales quedan en disco en
  // qa/gate2/<lessonId>.json, igual que corriendo /gate2 lección por lección.
  runGate2AllStage(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
