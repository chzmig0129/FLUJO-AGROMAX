/**
 * GET /api/jobs — lista todos los jobs existentes (id, nombre y status),
 * leyendo el jobs/<id>/job.json de cada subdirectorio de JOBS_ROOT.
 *
 * Usado por la landing (src/app/page.tsx) para permitir navegar a jobs ya
 * creados sin tener que saber la URL de antemano.
 *
 * Lectura tolerante: si JOBS_ROOT todavía no existe (ningún job creado
 * todavía) devuelve una lista vacía en vez de un error. Si un subdirectorio
 * no tiene job.json legible (job a medio crear, o corrupto), se lo omite
 * en vez de romper el listado completo.
 */
import { NextResponse } from "next/server";
import { JOBS_ROOT, readJobJson } from "@/lib/jobs";
import { promises as fs } from "node:fs";

export const runtime = "nodejs";

interface JobSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export async function GET(): Promise<NextResponse> {
  let entries: string[];
  try {
    entries = await fs.readdir(JOBS_ROOT);
  } catch {
    // JOBS_ROOT todavía no existe: no hay jobs creados todavía.
    return NextResponse.json({ jobs: [] });
  }

  const jobs: JobSummary[] = [];
  await Promise.all(
    entries.map(async (id) => {
      try {
        const job = await readJobJson(id);
        jobs.push({
          id: job.id,
          name: job.name,
          status: job.status,
          createdAt: job.createdAt,
        });
      } catch {
        // job.json no legible (a medio crear o corrupto): se omite.
      }
    })
  );

  // Más recientes primero.
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json({ jobs });
}
