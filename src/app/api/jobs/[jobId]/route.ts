/**
 * GET /api/jobs/[jobId] — devuelve la metadata del job (job.json), más el
 * progreso de transcripción, la metadata de probe, el resumen final, el
 * manifest de frames, los artefactos de la etapa de plan (structure, audit,
 * verdicts, decisiones.md y approval — el gate de aprobación humana de la
 * etapa 6) y los artefactos de las etapas de preparación (5A/5B/5C: silence,
 * cuts y prepProgress) y de las etapas 9/11 (intros y ensamblaje:
 * assemblyProgress y los sidecars de render) si ya existen, para que la UI
 * pueda pollear un único endpoint.
 *
 * Nota: esta ruta es solo lectura. Nunca toca jobs/<id>/source/, que es
 * inmutable una vez creada la ingesta (ver invariante en src/lib/jobs.ts).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  jobPath,
  readApprovalJson,
  readAssemblyProgressJson,
  readAuditJson,
  readCutsFiles,
  readDecisionesMd,
  readFramesManifest,
  readGate2Verdict,
  readJobJson,
  readMediaJson,
  readPrepProgressJson,
  readProgressJson,
  readRenderSidecars,
  readSilenceJson,
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

/**
 * Lee qa/gate3/<moduleId>.json de un job. Devuelve null si el módulo
 * todavía no fue auditado (o si el JSON está a medio escribir), en vez de
 * lanzar un error. No hay helper dedicado en jobs.ts para esto, así que se
 * lee directo con fs desde jobPath (mismo patrón tolerante que
 * readCaptionsFile en src/lib/assembly/plan.ts).
 */
async function readGate3Verdict(
  id: string,
  moduleId: string
): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(
      path.join(jobPath(id), "qa", "gate3", `${moduleId}.json`),
      "utf-8"
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lee deliver/manifest.json de un job. Devuelve null si el curso todavía no
 * fue empaquetado. Lectura tolerante, mismo patrón que readSummaryJson.
 */
async function readPackageManifest(id: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(
      path.join(jobPath(id), "deliver", "manifest.json"),
      "utf-8"
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lee plan/overlays/<lessonId>.json de un job. Devuelve null si la lección
 * todavía no tiene briefs de overlays generados. Lectura tolerante, mismo
 * patrón que readCaptionsFile en src/lib/assembly/plan.ts.
 */
async function readOverlayBriefs(
  id: string,
  lessonId: string
): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(
      path.join(jobPath(id), "plan", "overlays", `${lessonId}.json`),
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
      approval,
      silence,
      cuts,
      prepProgress,
      assemblyProgress,
      renders,
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
      // Gate de aprobación humana (etapa 6): null si la estructura aún no
      // fue aprobada (o si una edición posterior invalidó la aprobación).
      readApprovalJson(jobId),
      // Artefactos de las etapas de preparación (5A/5B/5C): lecturas
      // tolerantes, devuelven null/[] si el job todavía no llegó a esa
      // etapa. readCutsFiles ya devuelve [] tolerante, así que se normaliza
      // a null cuando está vacío para que la UI distinga "sin cortes
      // todavía" de "lista vacía por alguna razón rara".
      readSilenceJson(jobId),
      readCutsFiles(jobId),
      readPrepProgressJson(jobId),
      // Artefactos de las etapas 9/11 (intros + ensamblaje): el progreso por
      // clase y los sidecars de los renders YA VERIFICADOS como completos.
      // La UI usa `renders` (no la existencia del .mp4) para decidir qué se
      // puede reproducir.
      readAssemblyProgressJson(jobId),
      readRenderSidecars(jobId),
    ]);

    // Veredictos del Gate 2 (QA visual, etapa posterior al ensamblaje): uno
    // por cada lección que ya tiene un render verificado. Lectura tolerante
    // (readGate2Verdict devuelve null si la lección todavía no fue auditada).
    const gate2Verdicts: Record<string, unknown | null> = {};
    if (renders.length > 0) {
      await Promise.all(
        renders.map(async (r) => {
          gate2Verdicts[r.lessonId] = await readGate2Verdict(
            jobId,
            r.lessonId
          );
        })
      );
    }

    // Veredictos del Gate 3 (revisión de módulo completo): uno por cada
    // módulo de la estructura, si ya existe. Lectura tolerante (null si el
    // módulo todavía no fue auditado).
    const gate3Verdicts: Record<string, unknown | null> = {};
    // Briefs de overlays generados (etapa de plan de overlays): uno por
    // cada lección de la estructura, si ya existe. Lectura tolerante (null
    // si la lección todavía no tiene briefs generados).
    const overlayBriefs: Record<string, unknown | null> = {};
    if (structure) {
      await Promise.all([
        ...structure.modules.map(async (m) => {
          gate3Verdicts[m.id] = await readGate3Verdict(jobId, m.id);
        }),
        ...structure.modules.flatMap((m) =>
          m.lessons.map(async (l) => {
            overlayBriefs[l.id] = await readOverlayBriefs(jobId, l.id);
          })
        ),
      ]);
    }

    // Manifest de empaquetado del curso (etapa de entrega): null si el
    // curso todavía no fue empaquetado.
    const packageManifest = await readPackageManifest(jobId);

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
      approval,
      silence,
      cuts: cuts.length > 0 ? cuts : null,
      prepProgress,
      assemblyProgress,
      renders: renders.length > 0 ? renders : null,
      gate2Verdicts,
      gate3Verdicts,
      packageManifest,
      overlayBriefs,
    });
  } catch {
    return NextResponse.json(
      { error: "Proyecto no encontrado" },
      { status: 404 }
    );
  }
}
