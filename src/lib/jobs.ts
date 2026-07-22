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
  Approval,
  AssemblyProgressJson,
  AuditJson,
  CaptionsFile,
  CutsFile,
  FramesManifest,
  Gate2FramesManifest,
  JobJson,
  JobStatus,
  MediaInfo,
  ProgressJson,
  RenderSidecar,
  SilenceJson,
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

/**
 * Ruta absoluta a plan/approval.json de un job (etapa 6, gate de
 * aprobación humana). Su existencia es la fuente de verdad de "la
 * estructura fue aprobada tal como está en disco".
 */
export function approvalJsonPath(id: string): string {
  return path.join(planDir(id), "approval.json");
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

/** Ruta absoluta al subdirectorio de assets generados (proxies, etc.) de un job. */
export function assetsDir(id: string): string {
  return path.join(jobPath(id), "assets");
}

/** Ruta absoluta al subdirectorio de proxies de edición de un job (etapa 5B). */
export function proxiesDir(id: string): string {
  return path.join(assetsDir(id), "proxies");
}

/** Ruta absoluta al subdirectorio de intros renderizados de un job (etapa 9). */
export function introsDir(id: string): string {
  return path.join(assetsDir(id), "intros");
}

/** Ruta absoluta a assets/intros/<lessonId>.mp4 de un job (etapa 9). */
export function introPath(id: string, lessonId: string): string {
  return path.join(introsDir(id), `${lessonId}.mp4`);
}

/**
 * Ruta absoluta al subdirectorio de renders finales de un job (etapa 11).
 * Es el ÚNICO lugar donde el ensamblaje escribe video terminado; source/ y
 * assets/proxies/ nunca se tocan.
 */
export function renderDir(id: string): string {
  return path.join(jobPath(id), "render");
}

/** Ruta absoluta a render/<lessonId>.mp4 de un job (etapa 11). */
export function renderPath(id: string, lessonId: string): string {
  return path.join(renderDir(id), `${lessonId}.mp4`);
}

/**
 * Ruta absoluta al sidecar de verificación render/<lessonId>.json — la
 * fuente de verdad sobre "este render está completo" (ver RenderSidecar).
 */
export function renderSidecarPath(id: string, lessonId: string): string {
  return path.join(renderDir(id), `${lessonId}.json`);
}

/** Ruta absoluta a probe/silence.json de un job (etapa 5A). */
export function silenceJsonPath(id: string): string {
  return path.join(probeDir(id), "silence.json");
}

/** Ruta absoluta al subdirectorio de cortes deterministas por lección de un job (etapa 5C). */
export function cutsDir(id: string): string {
  return path.join(planDir(id), "cuts");
}

/** Ruta absoluta a plan/cuts/<lessonId>.json de un job. */
function cutsFilePath(id: string, lessonId: string): string {
  return path.join(cutsDir(id), `${lessonId}.json`);
}

/**
 * Ruta absoluta al subdirectorio de captions por lección de un job (etapa
 * post-cortes: agrupación de palabras de Whisper remapeadas al timeline de
 * salida).
 */
export function captionsDir(id: string): string {
  return path.join(planDir(id), "captions");
}

/** Ruta absoluta a plan/captions/<lessonId>.json de un job. */
export function captionsJsonPath(id: string, lessonId: string): string {
  return path.join(captionsDir(id), `${lessonId}.json`);
}

/** Ruta absoluta a progress/prep-progress.json de un job (etapas 5A/5B/5C). */
export function prepProgressJsonPath(id: string): string {
  return path.join(progressDir(id), "prep-progress.json");
}

/** Ruta absoluta a progress/assembly-progress.json de un job (etapas 9 y 11). */
export function assemblyProgressJsonPath(id: string): string {
  return path.join(progressDir(id), "assembly-progress.json");
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
 * Escribe (o sobrescribe) plan/approval.json de un job (etapa 6, gate de
 * aprobación humana). Crea plan/ de forma recursiva si todavía no existe.
 */
export async function writeApprovalJson(
  id: string,
  approval: Approval
): Promise<void> {
  await fs.mkdir(planDir(id), { recursive: true });
  await fs.writeFile(
    approvalJsonPath(id),
    JSON.stringify(approval, null, 2),
    "utf-8"
  );
}

/**
 * Lee plan/approval.json de un job. Devuelve null si todavía no existe (la
 * estructura aún no fue aprobada, o fue invalidada por una edición) en vez
 * de lanzar un error.
 */
export async function readApprovalJson(
  id: string
): Promise<Approval | null> {
  try {
    const raw = await fs.readFile(approvalJsonPath(id), "utf-8");
    return JSON.parse(raw) as Approval;
  } catch {
    return null;
  }
}

/**
 * Borra plan/approval.json de un job, tolerante a que no exista (no lanza
 * error si ya estaba borrado o nunca se creó). Se usa cada vez que la
 * estructura se edita vía PUT, porque editar invalida la aprobación previa.
 */
export async function deleteApprovalJson(id: string): Promise<void> {
  try {
    await fs.unlink(approvalJsonPath(id));
  } catch {
    // Tolerante: si no existe, no hay nada que borrar.
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
 * Escribe (o sobrescribe) probe/silence.json de un job (etapa 5A). Crea
 * probe/ de forma recursiva si todavía no existe.
 */
export async function writeSilenceJson(
  id: string,
  silence: SilenceJson
): Promise<void> {
  await fs.mkdir(probeDir(id), { recursive: true });
  await fs.writeFile(
    silenceJsonPath(id),
    JSON.stringify(silence, null, 2),
    "utf-8"
  );
}

/**
 * Lee probe/silence.json de un job. Devuelve null si todavía no existe (job
 * que aún no llegó a la etapa de silencio) en vez de lanzar un error.
 */
export async function readSilenceJson(
  id: string
): Promise<SilenceJson | null> {
  try {
    const raw = await fs.readFile(silenceJsonPath(id), "utf-8");
    return JSON.parse(raw) as SilenceJson;
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) plan/cuts/<lessonId>.json de un job (etapa 5C).
 * Crea plan/cuts/ de forma recursiva si todavía no existe. Idempotente:
 * sobrescribe por completo el archivo de esa lección.
 */
export async function writeCutsFile(
  id: string,
  lessonId: string,
  data: CutsFile
): Promise<void> {
  await fs.mkdir(cutsDir(id), { recursive: true });
  await fs.writeFile(
    cutsFilePath(id, lessonId),
    JSON.stringify(data, null, 2),
    "utf-8"
  );
}

/**
 * Lee todos los archivos de plan/cuts/ de un job. Devuelve un array vacío si
 * el directorio todavía no existe (job que aún no llegó a la etapa de
 * cortes) en vez de lanzar un error. Tolerante a archivos individuales
 * corruptos o no-JSON dentro de plan/cuts/: los ignora en vez de abortar la
 * lectura completa (por ejemplo si un worker quedó a medio escribir).
 */
export async function readCutsFiles(id: string): Promise<CutsFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(cutsDir(id));
  } catch {
    return [];
  }

  const results: CutsFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(cutsDir(id), entry), "utf-8");
      results.push(JSON.parse(raw) as CutsFile);
    } catch {
      // Archivo corrupto o a medio escribir: se ignora en vez de abortar
      // la lectura de los demás archivos de cuts/.
      continue;
    }
  }
  return results;
}

/**
 * Escribe (o sobrescribe) plan/captions/<lessonId>.json de un job (etapa
 * post-cortes). El lessonId sale de `file.lessonId`. Crea plan/captions/ de
 * forma recursiva si todavía no existe. Idempotente: sobrescribe por
 * completo el archivo de esa lección.
 */
export async function writeCaptionsJson(
  id: string,
  file: CaptionsFile
): Promise<void> {
  await fs.mkdir(captionsDir(id), { recursive: true });
  await fs.writeFile(
    captionsJsonPath(id, file.lessonId),
    JSON.stringify(file, null, 2),
    "utf-8"
  );
}

/**
 * Lee plan/captions/<lessonId>.json de un job. Devuelve null si todavía no
 * existe (job que aún no llegó a la etapa de captions, o lección sin
 * archivo) en vez de lanzar un error.
 */
export async function readCaptionsJson(
  id: string,
  lessonId: string
): Promise<CaptionsFile | null> {
  try {
    const raw = await fs.readFile(captionsJsonPath(id, lessonId), "utf-8");
    return JSON.parse(raw) as CaptionsFile;
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) progress/prep-progress.json de un job (etapas
 * 5A/5B/5C). Crea progress/ de forma recursiva si todavía no existe.
 */
export async function writePrepProgressJson(
  id: string,
  progress: ProgressJson
): Promise<void> {
  await fs.mkdir(progressDir(id), { recursive: true });
  await fs.writeFile(
    prepProgressJsonPath(id),
    JSON.stringify(progress, null, 2),
    "utf-8"
  );
}

/**
 * Lee progress/prep-progress.json de un job. Devuelve null si todavía no
 * existe en vez de lanzar un error.
 */
export async function readPrepProgressJson(
  id: string
): Promise<ProgressJson | null> {
  try {
    const raw = await fs.readFile(prepProgressJsonPath(id), "utf-8");
    return JSON.parse(raw) as ProgressJson;
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) progress/assembly-progress.json de un job (etapas
 * 9 y 11). Crea progress/ de forma recursiva si todavía no existe.
 */
export async function writeAssemblyProgressJson(
  id: string,
  progress: AssemblyProgressJson
): Promise<void> {
  await fs.mkdir(progressDir(id), { recursive: true });
  await fs.writeFile(
    assemblyProgressJsonPath(id),
    JSON.stringify(progress, null, 2),
    "utf-8"
  );
}

/**
 * Lee progress/assembly-progress.json de un job. Devuelve null si todavía no
 * existe en vez de lanzar un error.
 */
export async function readAssemblyProgressJson(
  id: string
): Promise<AssemblyProgressJson | null> {
  try {
    const raw = await fs.readFile(assemblyProgressJsonPath(id), "utf-8");
    return JSON.parse(raw) as AssemblyProgressJson;
  } catch {
    return null;
  }
}

/** Escribe el sidecar de verificación render/<lessonId>.json de una clase. */
export async function writeRenderSidecar(
  id: string,
  sidecar: RenderSidecar
): Promise<void> {
  await fs.mkdir(renderDir(id), { recursive: true });
  await fs.writeFile(
    renderSidecarPath(id, sidecar.lessonId),
    JSON.stringify(sidecar, null, 2),
    "utf-8"
  );
}

/**
 * Lee el sidecar de verificación de una clase. Devuelve null si no existe o
 * si no está en estado 'complete' (un sidecar corrupto o de otra versión NO
 * debe hacer pasar por bueno un render a medio escribir).
 */
export async function readRenderSidecar(
  id: string,
  lessonId: string
): Promise<RenderSidecar | null> {
  try {
    const raw = await fs.readFile(renderSidecarPath(id, lessonId), "utf-8");
    const parsed = JSON.parse(raw) as RenderSidecar;
    return parsed.status === "complete" ? parsed : null;
  } catch {
    return null;
  }
}

/** Lee todos los sidecars de render presentes en render/ de un job. */
export async function readRenderSidecars(
  id: string
): Promise<RenderSidecar[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(renderDir(id));
  } catch {
    return [];
  }

  const results: RenderSidecar[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const sidecar = await readRenderSidecar(id, path.basename(entry, ".json"));
    if (sidecar) results.push(sidecar);
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * Etapa 14 (Gate 2: QA visual sobre el render final)
 * ------------------------------------------------------------------ */

/** Ruta absoluta al subdirectorio de QA de un job. */
export function qaDir(id: string): string {
  return path.join(jobPath(id), "qa");
}

/** Ruta absoluta al subdirectorio de Gate 2 (QA visual) de un job. */
export function gate2Dir(id: string): string {
  return path.join(qaDir(id), "gate2");
}

/** Ruta absoluta al subdirectorio de frames extraídos de Gate 2 de una clase. */
export function gate2FramesDir(id: string, lessonId: string): string {
  return path.join(gate2Dir(id), "frames", lessonId);
}

/** Ruta absoluta a qa/gate2/frames/<lessonId>/manifest.json de un job. */
export function gate2ManifestPath(id: string, lessonId: string): string {
  return path.join(gate2FramesDir(id, lessonId), "manifest.json");
}

/** Ruta absoluta al veredicto de Gate 2 de una clase: qa/gate2/<lessonId>.json. */
export function gate2VerdictPath(id: string, lessonId: string): string {
  return path.join(gate2Dir(id), `${lessonId}.json`);
}

/**
 * Lee qa/gate2/<lessonId>.json de un job. Devuelve null si todavía no existe
 * o si el contenido no es JSON válido (parseo tolerante: un veredicto a
 * medio escribir no debe tumbar al que lo consume), en vez de lanzar un
 * error. El tipo se deja sin normalizar (unknown): quien lo consume decide
 * la forma exacta del veredicto.
 */
export async function readGate2Verdict(
  id: string,
  lessonId: string
): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(gate2VerdictPath(id, lessonId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Escribe (o sobrescribe) qa/gate2/frames/<lessonId>/manifest.json de un job
 * (etapa 14). Crea el directorio de forma recursiva si todavía no existe.
 */
export async function writeGate2FramesManifest(
  id: string,
  manifest: Gate2FramesManifest
): Promise<void> {
  await fs.mkdir(gate2FramesDir(id, manifest.lessonId), { recursive: true });
  await fs.writeFile(
    gate2ManifestPath(id, manifest.lessonId),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
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
      silence?: { startedAt?: string; finishedAt?: string };
      proxies?: { startedAt?: string; finishedAt?: string };
      cuts?: { startedAt?: string; finishedAt?: string };
      captions?: { startedAt?: string; finishedAt?: string };
      intros?: { startedAt?: string; finishedAt?: string };
      assembly?: { startedAt?: string; finishedAt?: string };
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
        silence: mergeStageTiming(
          current.stages?.silence,
          extra.stages.silence
        ),
        proxies: mergeStageTiming(
          current.stages?.proxies,
          extra.stages.proxies
        ),
        cuts: mergeStageTiming(current.stages?.cuts, extra.stages.cuts),
        captions: mergeStageTiming(
          current.stages?.captions,
          extra.stages.captions
        ),
        intros: mergeStageTiming(current.stages?.intros, extra.stages.intros),
        assembly: mergeStageTiming(
          current.stages?.assembly,
          extra.stages.assembly
        ),
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
