/**
 * jobs.ts — persistencia de jobs en filesystem (solo servidor).
 *
 * Estructura en disco:
 *   jobs/<id>/source/    archivos de video originales, tal como se extraen del ZIP
 *   jobs/<id>/job.json   metadata del job (JobJson)
 *
 * INVARIANTE IMPORTANTE: jobs/<id>/source/ es inmutable una vez creada en la
 * ingesta. Ningún código posterior (etapas futuras del pipeline) debe
 * escribir, mover ni borrar archivos dentro de source/. Solo se leen.
 *
 * Este módulo es server-only: usa node:fs/promises y node:path, por lo que
 * nunca debe importarse desde código de cliente (componentes "use client").
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AuditJson,
  FramesManifest,
  JobJson,
  JobStatus,
  MediaInfo,
  ProgressJson,
  StageTiming,
  StructureJson,
  Verdict,
} from "./types";

/** Raíz absoluta donde viven todos los jobs (jobs/ en la raíz del proyecto). */
export const JOBS_ROOT = path.join(process.cwd(), "jobs");

/** Ruta absoluta al directorio de un job dado su id. */
export function jobPath(id: string): string {
  return path.join(JOBS_ROOT, id);
}

/** Ruta absoluta al subdirectorio inmutable source/ de un job. */
export function sourcePath(id: string): string {
  return path.join(jobPath(id), "source");
}

/** Ruta absoluta a job.json de un job. */
function jobJsonPath(id: string): string {
  return path.join(jobPath(id), "job.json");
}

/** Ruta absoluta al subdirectorio de salida de la etapa de probe. */
export function probeDir(id: string): string {
  return path.join(jobPath(id), "probe");
}

/** Ruta absoluta al subdirectorio de salida de la etapa de transcripción. */
export function transcriptsDir(id: string): string {
  return path.join(jobPath(id), "transcripts");
}

/** Ruta absoluta a probe/media.json de un job. */
export function mediaJsonPath(id: string): string {
  return path.join(probeDir(id), "media.json");
}

/** Ruta absoluta al subdirectorio de salida de la etapa de muestreo de frames. */
export function framesDir(id: string): string {
  return path.join(jobPath(id), "frames");
}

/** Ruta absoluta a frames/manifest.json de un job. */
export function manifestPath(id: string): string {
  return path.join(framesDir(id), "manifest.json");
}

/** Ruta absoluta al subdirectorio de salida de la etapa de plan (filtro editorial y estructura). */
export function planDir(id: string): string {
  return path.join(jobPath(id), "plan");
}

/** Ruta absoluta a plan/verdicts.json de un job. */
export function verdictsJsonPath(id: string): string {
  return path.join(planDir(id), "verdicts.json");
}

/** Ruta absoluta a plan/structure.json de un job. */
export function structureJsonPath(id: string): string {
  return path.join(planDir(id), "structure.json");
}

/** Ruta absoluta a plan/audit.json de un job. */
export function auditJsonPath(id: string): string {
  return path.join(planDir(id), "audit.json");
}

/** Ruta absoluta a plan/decisiones.md de un job. */
export function decisionesMdPath(id: string): string {
  return path.join(planDir(id), "decisiones.md");
}

/** Ruta absoluta a progress/progress.json de un job. */
function progressDir(id: string): string {
  return path.join(jobPath(id), "progress");
}

/** Ruta absoluta a progress/progress.json de un job. */
export function progressJsonPath(id: string): string {
  return path.join(progressDir(id), "progress.json");
}

/**
 * Crea jobs/<id>/source/ de forma recursiva (y por lo tanto jobs/<id>/).
 * Debe llamarse una única vez al iniciar la ingesta de un job; después de
 * esto, source/ no vuelve a modificarse (ver invariante en el header).
 */
export async function createJobDir(id: string): Promise<void> {
  await fs.mkdir(sourcePath(id), { recursive: true });
}

/**
 * Escribe (o sobrescribe) job.json, refrescando siempre updatedAt al momento
 * de la escritura. createdAt no se toca aquí: debe venir ya seteado por
 * quien construye el objeto JobJson la primera vez.
 */
export async function writeJobJson(job: JobJson): Promise<void> {
  const jobToWrite: JobJson = {
    ...job,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    jobJsonPath(jobToWrite.id),
    JSON.stringify(jobToWrite, null, 2),
    "utf-8"
  );
}

/**
 * Lee job.json de un job. Lanza un error claro (en español) si el job no
 * existe o el archivo no puede leerse, en vez de propagar el ENOENT crudo.
 */
export async function readJobJson(id: string): Promise<JobJson> {
  try {
    const raw = await fs.readFile(jobJsonPath(id), "utf-8");
    return JSON.parse(raw) as JobJson;
  } catch {
    throw new Error(`Proyecto no encontrado: no existe el job "${id}"`);
  }
}

/**
 * Escribe (o sobrescribe) probe/media.json de un job. Crea probe/ de forma
 * recursiva si todavía no existe.
 */
export async function writeMediaJson(
  id: string,
  media: MediaInfo[]
): Promise<void> {
  await fs.mkdir(probeDir(id), { recursive: true });
  await fs.writeFile(
    mediaJsonPath(id),
    JSON.stringify(media, null, 2),
    "utf-8"
  );
}

/**
 * Lee probe/media.json de un job. Devuelve null si todavía no existe
 * (job que aún no llegó a la etapa de probe) en vez de lanzar un error.
 */
export async function readMediaJson(
  id: string
): Promise<MediaInfo[] | null> {
  try {
    const raw = await fs.readFile(mediaJsonPath(id), "utf-8");
    return JSON.parse(raw) as MediaInfo[];
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) progress/progress.json de un job. Crea progress/
 * de forma recursiva si todavía no existe.
 */
export async function writeProgressJson(
  id: string,
  progress: ProgressJson
): Promise<void> {
  await fs.mkdir(progressDir(id), { recursive: true });
  await fs.writeFile(
    progressJsonPath(id),
    JSON.stringify(progress, null, 2),
    "utf-8"
  );
}

/**
 * Lee progress/progress.json de un job. Devuelve null si todavía no existe
 * en vez de lanzar un error.
 */
export async function readProgressJson(
  id: string
): Promise<ProgressJson | null> {
  try {
    const raw = await fs.readFile(progressJsonPath(id), "utf-8");
    return JSON.parse(raw) as ProgressJson;
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) frames/manifest.json de un job. Crea frames/ de
 * forma recursiva si todavía no existe.
 */
export async function writeFramesManifest(
  id: string,
  manifest: FramesManifest
): Promise<void> {
  await fs.mkdir(framesDir(id), { recursive: true });
  await fs.writeFile(
    manifestPath(id),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
}

/**
 * Lee frames/manifest.json de un job. Devuelve null si todavía no existe
 * (job que aún no llegó a la etapa de muestreo) en vez de lanzar un error.
 */
export async function readFramesManifest(
  id: string
): Promise<FramesManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(id), "utf-8");
    return JSON.parse(raw) as FramesManifest;
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) plan/verdicts.json de un job. Crea plan/ de forma
 * recursiva si todavía no existe.
 */
export async function writeVerdictsJson(
  id: string,
  verdicts: Verdict[]
): Promise<void> {
  await fs.mkdir(planDir(id), { recursive: true });
  await fs.writeFile(
    verdictsJsonPath(id),
    JSON.stringify(verdicts, null, 2),
    "utf-8"
  );
}

/**
 * Lee plan/verdicts.json de un job. Devuelve null si todavía no existe (job
 * que aún no llegó a la etapa de plan) en vez de lanzar un error.
 */
export async function readVerdictsJson(
  id: string
): Promise<Verdict[] | null> {
  try {
    const raw = await fs.readFile(verdictsJsonPath(id), "utf-8");
    return JSON.parse(raw) as Verdict[];
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) plan/structure.json de un job. Crea plan/ de forma
 * recursiva si todavía no existe.
 */
export async function writeStructureJson(
  id: string,
  structure: StructureJson
): Promise<void> {
  await fs.mkdir(planDir(id), { recursive: true });
  await fs.writeFile(
    structureJsonPath(id),
    JSON.stringify(structure, null, 2),
    "utf-8"
  );
}

/**
 * Lee plan/structure.json de un job. Devuelve null si todavía no existe en
 * vez de lanzar un error.
 */
export async function readStructureJson(
  id: string
): Promise<StructureJson | null> {
  try {
    const raw = await fs.readFile(structureJsonPath(id), "utf-8");
    return JSON.parse(raw) as StructureJson;
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) plan/audit.json de un job. Crea plan/ de forma
 * recursiva si todavía no existe.
 */
export async function writeAuditJson(
  id: string,
  audit: AuditJson
): Promise<void> {
  await fs.mkdir(planDir(id), { recursive: true });
  await fs.writeFile(auditJsonPath(id), JSON.stringify(audit, null, 2), "utf-8");
}

/**
 * Lee plan/audit.json de un job. Devuelve null si todavía no existe en vez
 * de lanzar un error.
 */
export async function readAuditJson(id: string): Promise<AuditJson | null> {
  try {
    const raw = await fs.readFile(auditJsonPath(id), "utf-8");
    return JSON.parse(raw) as AuditJson;
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) plan/decisiones.md de un job. Crea plan/ de forma
 * recursiva si todavía no existe. A diferencia de los demás archivos de
 * plan/, este es texto plano en Markdown, no JSON.
 */
export async function writeDecisionesMd(
  id: string,
  contents: string
): Promise<void> {
  await fs.mkdir(planDir(id), { recursive: true });
  await fs.writeFile(decisionesMdPath(id), contents, "utf-8");
}

/**
 * Lee plan/decisiones.md de un job. Devuelve null si todavía no existe en
 * vez de lanzar un error.
 */
export async function readDecisionesMd(id: string): Promise<string | null> {
  try {
    return await fs.readFile(decisionesMdPath(id), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Mergea el timing existente de una etapa con un patch parcial (por ejemplo
 * solo finishedAt), sin perder el startedAt ya guardado. Si no hay timing
 * previo ni el patch trae startedAt, no hay nada consistente que guardar.
 */
function mergeStageTiming(
  current: StageTiming | undefined,
  patch: { startedAt?: string; finishedAt?: string } | undefined
): StageTiming | undefined {
  if (!patch) return current;
  const startedAt = patch.startedAt ?? current?.startedAt;
  if (!startedAt) {
    throw new Error(
      "No se puede registrar finishedAt de una etapa sin startedAt previo"
    );
  }
  return {
    startedAt,
    finishedAt: patch.finishedAt ?? current?.finishedAt,
  };
}

/**
 * Actualiza el status de un job (y opcionalmente su stages/errorMessage),
 * mergeando en vez de sobrescribir job.json entero. Lee el job.json actual,
 * mergea `extra.stages` (por etapa) y `extra.errorMessage`, refresca
 * updatedAt (vía writeJobJson) y persiste.
 */
export async function updateJobStatus(
  id: string,
  status: JobStatus,
  extra?: {
    // Partial<StageTiming> por etapa: permite pasar solo finishedAt sin
    // pisar el startedAt ya guardado (el merge por etapa hace esa fusión).
    stages?: {
      probe?: { startedAt?: string; finishedAt?: string };
      transcribe?: { startedAt?: string; finishedAt?: string };
      frames?: { startedAt?: string; finishedAt?: string };
      plan?: { startedAt?: string; finishedAt?: string };
    };
    errorMessage?: string;
  }
): Promise<JobJson> {
  const current = await readJobJson(id);

  const mergedStages = extra?.stages
    ? {
        probe: mergeStageTiming(current.stages?.probe, extra.stages.probe),
        transcribe: mergeStageTiming(
          current.stages?.transcribe,
          extra.stages.transcribe
        ),
        frames: mergeStageTiming(
          current.stages?.frames,
          extra.stages.frames
        ),
        plan: mergeStageTiming(current.stages?.plan, extra.stages.plan),
      }
    : current.stages;

  const updated: JobJson = {
    ...current,
    status,
    stages: mergedStages,
    // errorMessage se limpia si no se pasa explícitamente y el nuevo status
    // no es 'error' (para no arrastrar un error viejo tras un re-intento OK).
    errorMessage:
      extra?.errorMessage !== undefined
        ? extra.errorMessage
        : status === "error"
          ? current.errorMessage
          : undefined,
  };

  await writeJobJson(updated);
  return readJobJson(id);
}
