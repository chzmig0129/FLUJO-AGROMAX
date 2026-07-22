/**
 * POST /api/jobs/[jobId]/package — corre la etapa 16 (empaquetado de
 * entrega) de un job: arma `deliver/CURSO_<slug>/` con el .mp4 final de
 * cada clase renombrado, un NOTAS.md por clase y los archivos a nivel de
 * curso (ESTRUCTURA_CURSO.md, QA_LOG.md, DECISIONES.md) — ver
 * `@/lib/package-stage`.
 *
 * 404 si el job no existe. 400 si el job todavía no tiene NINGÚN render en
 * `render/` (prerequisito mínimo: no tiene sentido empaquetar una entrega
 * sin al menos una clase renderizada). Fire-and-forget: no se espera a que
 * termine el empaquetado completo para responder, mismo patrón que
 * `/api/jobs/[jobId]/prep` y `/api/jobs/[jobId]/gate2`. `runPackageStage`
 * valida por su cuenta, de forma más estricta, que CADA clase de la
 * estructura tenga su render antes de copiarlo.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { readJobJson, renderDir } from "@/lib/jobs";
import { runPackageStage } from "@/lib/package-stage";

export const runtime = "nodejs";

/** Verifica (tolerante) si `render/` tiene al menos un .mp4. */
async function hasAnyRender(jobId: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(renderDir(jobId));
  } catch {
    return false;
  }
  return entries.some((entry) => path.extname(entry) === ".mp4");
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

  if (!(await hasAnyRender(jobId))) {
    return NextResponse.json(
      {
        error: `No se puede empaquetar: el job '${jobId}' todavía no tiene ningún render en 'render/' (falta ensamblar al menos una clase primero).`,
      },
      { status: 400 }
    );
  }

  // Fire-and-forget: no se espera a que termine el empaquetado para responder.
  runPackageStage(jobId).catch(console.error);

  return NextResponse.json({ ok: true });
}
