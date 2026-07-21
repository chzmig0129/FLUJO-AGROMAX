/**
 * GET /api/jobs/[jobId] — devuelve la metadata del job (job.json), más el
 * progreso de transcripción, la metadata de probe, el resumen final, el
 * manifest de frames y los artefactos de la etapa de plan (structure, audit,
 * verdicts y decisiones.md) si ya existen, para que la UI pueda pollear un
 * único endpoint.
 *
 * Nota: esta ruta es solo lectura. Nunca toca jobs/<id>/source/, que es
 * inmutable una vez creada la ingesta (ver invariante en src/lib/jobs.ts).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  readAuditJson,
  readDecisionesMd,
  readFramesManifest,
  readJobJson,
  readMediaJson,
  readProgressJson,
  readStructureJson,
  readVerdictsJson,
  transcriptsDir,
} from "@/lib/jobs";

export const runtime = "nodejs";

/**
 * Lee transcripts/summary.json de un job. Devuelve null si todavía no
 * existe (job que aún no terminó la etapa de transcripción) en vez de
 * lanzar un error. No hay helper dedicado en jobs.ts para esto, así que se
 * lee directo con fs desde transcriptsDir.
 */
async function readSummaryJson(id: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(
      path.join(transcriptsDir(id), "summary.json"),
      "utf-8"
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    const job = await readJobJson(jobId);
    const [
      media,
      progress,
      summary,
      manifest,
      structure,
      audit,
      verdicts,
      decisiones,
    ] = await Promise.all([
      readMediaJson(jobId),
      readProgressJson(jobId),
      readSummaryJson(jobId),
      readFramesManifest(jobId),
      // Artefactos de la etapa de plan (filtro editorial y estructura
      // autónoma): lecturas tolerantes, devuelven null si el job todavía no
      // llegó a esa etapa.
      readStructureJson(jobId),
      readAuditJson(jobId),
      readVerdictsJson(jobId),
      readDecisionesMd(jobId),
    ]);

    return NextResponse.json({
      job,
      media,
      progress,
      summary,
      manifest,
      structure,
      audit,
      verdicts,
      decisiones,
    });
  } catch {
    return NextResponse.json(
      { error: "Proyecto no encontrado" },
      { status: 404 }
    );
  }
}
