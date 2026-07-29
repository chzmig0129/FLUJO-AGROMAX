/**
 * POST /api/jobs/[jobId]/gate3 — corre el "Gate 3" de QA de módulo de un job
 * (etapa 15 del diseño): juez de coherencia entre clases + consistencia
 * visual cross-clase, vía Claude Code (`runGate3Stage`, `gate3-stage.ts`,
 * comando `/gate3-modulo`, con visión).
 *
 * Body: {moduleId: string} — 400 si falta o no es string. 404 si el job no
 * existe. 400 si el módulo no existe en `plan/structure.json` o ninguna de
 * sus lecciones tiene todavía `render/<lessonId>.mp4` (prerequisito real:
 * al menos una clase del módulo ya fue ensamblada). Fire-and-forget: no se
 * espera a que termine el gate completo (frames + juez) para responder,
 * mismo patrón que `/api/jobs/[jobId]/gate2`.
 *
 * Candado anti-duplicados (run-lock): 409 si Gate 3 ya está corriendo para
 * este job.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { listRenderedLessonsInModule, runGate3Stage } from "@/lib/gate3-stage";
import { release, tryAcquire } from "@/lib/run-lock";

export const runtime = "nodejs";

const STAGE = "gate3";

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

  // El body es requerido (a diferencia de /prep): sin moduleId no hay qué
  // auditar, y no se trata como {} silencioso.
  let body: { moduleId?: unknown } = {};
  try {
    const parsed = await request.json();
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as { moduleId?: unknown };
    }
  } catch {
    // Body ausente o inválido: se mantiene {} (sin moduleId -> 400 abajo).
  }

  const moduleId = body.moduleId;
  if (typeof moduleId !== "string" || moduleId.trim() === "") {
    return NextResponse.json(
      { error: "Falta 'moduleId' en el body" },
      { status: 400 }
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
    const renderedLessons = await listRenderedLessonsInModule(jobId, moduleId);
    if (renderedLessons.length === 0) {
      return NextResponse.json(
        {
          error: `No se puede correr Gate 3: el módulo '${moduleId}' no existe en la estructura del job, o ninguna de sus lecciones tiene todavía 'render/<lessonId>.mp4' (falta ensamblar al menos una clase del módulo primero).`,
        },
        { status: 400 }
      );
    }

    started = true;
    // Fire-and-forget: no se espera a que termine Gate 3 para responder.
    runGate3Stage(jobId, moduleId)
      .catch(console.error)
      .finally(() => release(jobId, STAGE));

    return NextResponse.json({ ok: true });
  } finally {
    if (!started) release(jobId, STAGE);
  }
}
