/**
 * POST /api/jobs/[jobId]/gate2 — corre el "Gate 2" de QA visual por clase de
 * un job: primero la etapa de muestreo de frames (`runGate2FramesStage`,
 * `gate2-frames-stage.ts`) y luego el juez visual vía Claude Code
 * (`runGate2Stage`, `gate2-stage.ts`, comando `/gate2-clase`, con visión).
 *
 * Body: {lessonId: string} — 400 si falta o no es string. 404 si el job no
 * existe. 400 si la lección todavía no tiene `render/<lessonId>.mp4`
 * (prerequisito real: la clase ya fue renderizada, no hay frames que
 * muestrear de un video que no existe). Fire-and-forget: no se espera a que
 * termine el gate completo (frames + juez) para responder, mismo patrón que
 * `/api/jobs/[jobId]/prep`.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { readJobJson, jobPath } from "@/lib/jobs";
import { runGate2FramesStage } from "@/lib/gate2-frames-stage";
import { runGate2Stage } from "@/lib/gate2-stage";

export const runtime = "nodejs";

/** Verifica (tolerante) si `render/<lessonId>.mp4` ya existe. */
async function hasRenderedLesson(jobId: string, lessonId: string): Promise<boolean> {
  try {
    await fs.access(path.join(jobPath(jobId), "render", `${lessonId}.mp4`));
    return true;
  } catch {
    return false;
  }
}

/** Corre las dos etapas de Gate 2 en secuencia: frames primero, luego el juez visual. */
async function runGate2(jobId: string, lessonId: string): Promise<void> {
  await runGate2FramesStage(jobId, lessonId);
  await runGate2Stage(jobId, lessonId);
}

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

  // El body es requerido (a diferencia de /prep): sin lessonId no hay qué
  // auditar, y no se trata como {} silencioso.
  let body: { lessonId?: unknown } = {};
  try {
    const parsed = await request.json();
    if (typeof parsed === "object" && parsed !== null) {
      body = parsed as { lessonId?: unknown };
    }
  } catch {
    // Body ausente o inválido: se mantiene {} (sin lessonId -> 400 abajo).
  }

  const lessonId = body.lessonId;
  if (typeof lessonId !== "string" || lessonId.trim() === "") {
    return NextResponse.json(
      { error: "Falta 'lessonId' en el body" },
      { status: 400 }
    );
  }

  if (!(await hasRenderedLesson(jobId, lessonId))) {
    return NextResponse.json(
      {
        error: `No se puede correr Gate 2: la lección '${lessonId}' todavía no tiene 'render/${lessonId}.mp4' (falta renderizarla primero).`,
      },
      { status: 400 }
    );
  }

  // Fire-and-forget: no se espera a que termine Gate 2 para responder.
  runGate2(jobId, lessonId).catch(console.error);

  return NextResponse.json({ ok: true });
}
