/**
 * GET /api/jobs/[jobId] — devuelve la metadata del job (job.json), más el
 * progreso de transcripción, la metadata de probe y el resumen final si ya
 * existen, para que la UI pueda pollear un único endpoint.
 *
 * Nota: esta ruta es solo lectura. Nunca toca jobs/<id>/source/, que es
 * inmutable una vez creada la ingesta (ver invariante en src/lib/jobs.ts).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { readJobJson, readMediaJson, readProgressJson, transcriptsDir } from "@/lib/jobs";

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
    const [media, progress, summary] = await Promise.all([
      readMediaJson(jobId),
      readProgressJson(jobId),
      readSummaryJson(jobId),
    ]);

    return NextResponse.json({ job, media, progress, summary });
  } catch {
    return NextResponse.json(
      { error: "Proyecto no encontrado" },
      { status: 404 }
    );
  }
}
