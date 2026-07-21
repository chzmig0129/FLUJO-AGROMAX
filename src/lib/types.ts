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
 * Estado general de un job a través de todo el pipeline (ingesta → probe →
 * transcripción → muestreo de frames).
 * - 'ingested': el ZIP fue extraído y analizado con éxito (etapa 1 lista).
 * - 'probing': corriendo ffprobe sobre los archivos de source/ (etapa 2).
 * - 'probed': probe/media.json fue generado con éxito.
 * - 'transcribing': corriendo el motor de transcripción (etapa 3).
 * - 'transcribed': transcripts/ fue generado con éxito.
 * - 'sampling': corriendo la extracción de frames de referencia con ffmpeg (etapa 3.5).
 * - 'sampled': frames/ y frames/manifest.json fueron generados con éxito.
 * - 'planning': corriendo el agente autónomo de filtro editorial y estructura (etapa 4).
 * - 'planned': plan/ fue generado con éxito (verdicts.json, structure.json, audit.json, decisiones.md).
 * - 'error': ocurrió un error irrecuperable en cualquier etapa del pipeline.
 */
export type JobStatus =
  | "ingested"
  | "probing"
  | "probed"
  | "transcribing"
  | "transcribed"
  | "sampling"
  | "sampled"
  | "planning"
  | "planned"
  | "error";

/**
 * Marca de tiempo de inicio/fin de una etapa del pipeline. `finishedAt`
 * queda ausente mientras la etapa está en curso.
 */
export interface StageTiming {
  startedAt: string;
  finishedAt?: string;
}

/**
 * Representación persistida de un job en jobs/<id>/job.json.
 * `stage` queda fijo en 'ingest' para esta etapa del pipeline.
 * `stages` acumula el historial de arranque/fin de cada etapa del pipeline
 * (probe, transcribe); `errorMessage` queda seteado cuando status === 'error'.
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
  stages?: {
    probe?: StageTiming;
    transcribe?: StageTiming;
    frames?: StageTiming;
    plan?: StageTiming;
  };
  errorMessage?: string;
}

/**
 * Metadata técnica de un archivo de video obtenida con ffprobe en la etapa
 * de probe (probe/media.json).
 */
export interface MediaInfo {
  filename: string;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  durationSeconds: number;
  audioChannels: number;
  audioSampleRate: number;
  /** true si el video excede 1080p o 30fps por su lado mayor/fps. */
  needsTranscode: boolean;
}

/**
 * Estado de la transcripción de un archivo individual, usado en
 * progress/progress.json para reportar avance por archivo a la UI.
 */
export type FileTranscriptStatus = "pending" | "running" | "done" | "error";

/**
 * Representación persistida del progreso de transcripción por archivo,
 * en jobs/<id>/progress/progress.json.
 */
export interface ProgressJson {
  files: Record<
    string,
    {
      status: FileTranscriptStatus;
      error?: string;
    }
  >;
}

/**
 * Un frame JPG extraído de un clip en la etapa de muestreo (3.5).
 * `timeSeconds` es el instante (redondeado a segundo entero) del video del
 * que se extrajo; `file` es la ruta relativa a jobs/<id>/frames/, por ejemplo
 * "<clip sin extensión>/frame_0012.jpg".
 */
export interface FrameEntry {
  timeSeconds: number;
  file: string;
}

/**
 * Resultado del muestreo de un clip individual dentro de frames/manifest.json.
 * `narration` indica si el clip tenía narración (lo que determina la
 * estrategia de muestreo usada: 4 puntos fijos vs. muestreo denso).
 */
export interface ManifestClip {
  filename: string;
  narration: boolean;
  durationSeconds: number;
  frames: FrameEntry[];
}

/**
 * Representación persistida de jobs/<id>/frames/manifest.json: el resultado
 * completo de la etapa de muestreo de frames para todos los clips del job.
 */
export interface FramesManifest {
  generatedAt: string;
  clips: ManifestClip[];
}

/**
 * Veredicto del agente de filtro editorial (etapa 4) sobre un clip
 * completo o un apartado del mismo.
 * - 'leccion': material utilizable dentro de la estructura del curso.
 * - 'broll': material de apoyo visual sin narración propia (se usa como
 *   B-roll dentro de alguna lección).
 * - 'descartar': tomas de prueba, retakes viejos, basura o inservible.
 * - 'otro_curso': pertenece a un curso distinto al que se está armando
 *   (ej. otra especie).
 */
export interface Verdict {
  clip: string;
  verdict: "leccion" | "broll" | "descartar" | "otro_curso";
  curso: string | null;
  razon: string;
  confianza: number;
  heuristicas: string[];
}

/**
 * Estructura del curso propuesta por el agente: módulos con lecciones, cada
 * lección compuesta de segmentos (rangos de tiempo dentro de un clip fuente).
 * `apartados` recoge los veredictos que no entran en la estructura principal
 * (descartados u de otro curso), para trazabilidad completa en la UI.
 */
export interface StructureJson {
  courseTitle: string;
  modules: Array<{
    id: string;
    title: string;
    order: number;
    topics: string[];
    lessons: Array<{
      id: string;
      title: string;
      order: number;
      segments: Array<{
        clip: string;
        startSeconds: number;
        endSeconds: number;
        topic: string;
      }>;
    }>;
  }>;
  apartados: Verdict[];
}

/**
 * Registro de auditoría de la corrida del agente de la etapa 4: uso de
 * tokens, llamadas a extraer_frames (con los parámetros usados y cuántos
 * frames nuevos agregaron) y, por clip, el veredicto final junto con si
 * hubo baja confianza o un cambio de decisión tras pedir frames extra.
 */
export interface AuditJson {
  generatedAt: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  };
  framesCalls: Array<{
    clip: string;
    params: {
      everySeconds?: number;
      count?: number;
      startSeconds?: number;
      endSeconds?: number;
    };
    framesAdded: number;
  }>;
  clips: Array<{
    clip: string;
    verdict: Verdict["verdict"];
    confianza: number;
    lowConfidence: boolean;
    heuristicas: string[];
    pidioFramesExtra: boolean;
    verdictAntes?: Verdict["verdict"];
    verdictDespues?: Verdict["verdict"];
    queCambio?: string;
  }>;
}
