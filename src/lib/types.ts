/**
 * Contrato de datos compartido por la etapa 1 (ingesta) del pipeline AgroMax.
 * Estos tipos son usados tanto por el backend (rutas API, jobs.ts, probe.ts)
 * como por los componentes de UI que consumen job.json.
 */

/**
 * Problemas detectados al analizar un archivo de video con ffprobe.
 * - 'not_a_video': el archivo no pudo ser leído como video (ffprobe falló o no hay stream de video).
 * - 'zero_duration': la duración detectada es <= 0.
 * - 'no_audio': el archivo no tiene ningún stream de audio.
 */
export type VideoIssue = "not_a_video" | "zero_duration" | "no_audio";

/**
 * Metadata de un archivo de video individual dentro de un job.
 * Un mismo archivo puede acumular varios issues a la vez.
 */
export interface VideoFileMeta {
  filename: string;
  durationSeconds: number;
  hasAudio: boolean;
  width: number;
  height: number;
  issues: VideoIssue[];
}

/**
 * Estado general de un job de ingesta.
 * - 'processing': se está analizando el ZIP subido (ffprobe en curso).
 * - 'ingested': el ZIP fue extraído y analizado con éxito.
 * - 'error': ocurrió un error irrecuperable durante la ingesta.
 */
export type JobStatus = "processing" | "ingested" | "error";

/**
 * Representación persistida de un job en jobs/<id>/job.json.
 * `stage` queda fijo en 'ingest' para esta etapa del pipeline.
 */
export interface JobJson {
  id: string;
  name: string;
  status: JobStatus;
  stage: "ingest";
  createdAt: string;
  updatedAt: string;
  config: Record<string, never>;
  files: VideoFileMeta[];
}
