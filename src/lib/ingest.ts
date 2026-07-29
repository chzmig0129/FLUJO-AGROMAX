/**
 * ingest.ts — flujo compartido de ingesta de un job a partir de un ZIP ya
 * presente en disco (jobs/<id>/upload.zip): extraer a source/, analizar con
 * ffprobe, persistir job.json y arrancar el pipeline en background.
 *
 * Usado tanto por POST /api/ingest (ZIP subido vía HTTP y guardado primero
 * en upload.zip) como por POST /api/ingest-local (ZIP que ya vivía en el
 * disco del server, copiado a upload.zip para no tocar el archivo original
 * del usuario).
 *
 * Server-only: usa fs, ffprobe (vía probeAll) y yauzl (vía extractVideosFromZip).
 */
import { promises as fs } from "node:fs";
import { sourcePath, writeJobJson } from "@/lib/jobs";
import { extractVideosFromZip } from "@/lib/zip";
import { probeAll } from "@/lib/probe";
import { runPipeline } from "@/lib/pipeline";
import type { JobJson, VideoFileMeta } from "@/lib/types";

/**
 * Mensajes de error conocidos que vienen de zip.ts y son atribuibles al
 * archivo ZIP en sí (400), a diferencia de cualquier otro fallo interno
 * (500).
 */
export function isKnownZipError(message: string): boolean {
  return (
    message === "El archivo ZIP está corrupto o no se pudo leer" ||
    message === "El ZIP no contiene archivos de video"
  );
}

/**
 * Ejecuta el flujo común de ingesta una vez que jobs/<id>/ ya existe y el
 * ZIP a ingerir ya está completamente escrito en `uploadZipPath`: extrae a
 * jobs/<id>/source/ (que queda inmutable desde aquí en adelante), borra el
 * ZIP intermedio (upload.zip; NUNCA el ZIP original del usuario si vino de
 * afuera de jobs/), analiza los videos con ffprobe, persiste job.json y
 * arranca el pipeline en background (sin await, no bloquea la respuesta).
 *
 * PRECONDICIÓN: jobs/<id>/ ya debe existir (createJobDir(id) ya llamado).
 * El llamador es responsable de limpiar jobs/<id>/ y loguear el error si
 * esta función lanza.
 */
export async function ingestFromLocalZip(
  id: string,
  name: string,
  uploadZipPath: string
): Promise<{ files: VideoFileMeta[] }> {
  // Extraemos los videos a source/, que queda inmutable desde aquí en
  // adelante (ver invariante documentada en lib/jobs.ts).
  await extractVideosFromZip(uploadZipPath, sourcePath(id));

  // El ZIP en upload.zip no es parte del job final: solo era un paso
  // intermedio (ya sea copiado desde el body HTTP o desde el ZIP local).
  await fs.rm(uploadZipPath, { force: true });

  const files = await probeAll(sourcePath(id));

  const now = new Date().toISOString();
  const job: JobJson = {
    id,
    name,
    status: "ingested",
    stage: "ingest",
    createdAt: now,
    updatedAt: now,
    config: {},
    files,
  };
  await writeJobJson(job);

  // Arrancamos el pipeline (probe + transcripción + muestreo de frames) en
  // background: no se hace await para no bloquear la respuesta del ingest.
  // El job queda en 'sampled' y se detiene ahí (modo manual por defecto): el
  // plan NO se dispara automáticamente, solo vía POST /api/jobs/[jobId]/plan.
  // Cualquier error se loguea (el pipeline mismo ya persiste el estado
  // 'error' en el job).
  runPipeline(id).catch(console.error);

  return { files };
}
