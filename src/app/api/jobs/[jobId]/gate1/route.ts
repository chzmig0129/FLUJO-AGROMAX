/**
 * POST /api/jobs/[jobId]/gate1 — corre el "Gate 1" de QA visual por overlay
 * de un job: el juez visual vía Claude Code (`runGate1Stage`,
 * `gate1-stage.ts`, comando `/gate1-overlays`, con visión).
 *
 * Sin body. 404 si el job no existe. 400 si el job todavía no tiene ningún
 * composite de chequeo en `qa/gate1-chk/*.jpg` (prerequisito real: hay que
 * haber generado al menos un overlay antes de poder inspeccionarlo).
 * Fire-and-forget: no se espera a que termine el gate para responder, mismo
 * patrón que `/api/jobs/[jobId]/gate2`.
 *
 * Candado anti-duplicados (run-lock): 409 si esta etapa ya está corriendo
 * para este job.
 */
import { NextResponse } from "next/server";
import { readJobJson } from "@/lib/jobs";
import { hasGate1Composites, runGate1Stage } from "@/lib/gate1-stage";
import { release, tryAcquire } from "@/lib/run-lock";

export const runtime = "nodejs";

const STAGE = "gate1";

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
    if (!(await hasGate1Composites(jobId))) {
      return NextResponse.json(
        {
          error: `No se puede correr Gate 1: el job '${jobId}' no tiene ningún composite en 'qa/gate1-chk/*.jpg' (falta generar overlays primero).`,
        },
        { status: 400 }
      );
    }

    started = true;
    // Fire-and-forget: no se espera a que termine Gate 1 para responder.
    runGate1Stage(jobId)
      .catch(console.error)
      .finally(() => release(jobId, STAGE));

    return NextResponse.json({ ok: true });
  } finally {
    if (!started) release(jobId, STAGE);
  }
}
