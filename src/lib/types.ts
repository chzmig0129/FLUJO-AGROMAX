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
 * - 'preparing': corriendo las etapas deterministas de preparación (5A/5B/5C:
 *   silencio, proxies y cortes) sobre los clips 'leccion' de la estructura.
 * - 'prepared': probe/silence.json, assets/proxies/ y plan/cuts/ fueron
 *   generados con éxito.
 * - 'assembling': corriendo las etapas 9 (intros) y 11 (ensamblaje headless)
 *   sobre las lecciones de la estructura.
 * - 'assembled': assets/intros/ y render/<lessonId>.mp4 fueron generados y
 *   VERIFICADOS como completos (ver assembly/verify.ts).
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
  | "preparing"
  | "prepared"
  | "assembling"
  | "assembled"
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
    silence?: StageTiming;
    proxies?: StageTiming;
    cuts?: StageTiming;
    /** Etapa 9: render de los intros por clase (assets/intros/). */
    intros?: StageTiming;
    /** Etapa 11: ensamblaje headless por clase (render/). */
    assembly?: StageTiming;
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
      /**
       * Tipo de lección: 'demo' es una clase donde el instructor trabaja con
       * las manos (laparoscopía, inseminación, descolado, inyecciones, etc.)
       * y por lo tanto NO se le recorta el silencio interno (el silencio ES
       * parte del contenido, no aire muerto). 'normal' es el resto. El
       * agente lo emite en la etapa 4; si falta (structure.json viejo), se
       * asume 'normal' como fallback.
       */
      kind?: "demo" | "normal";
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

/**
 * Un intervalo de silencio detectado por ffmpeg silencedetect dentro de un
 * clip, en probe/silence.json (etapa 5A).
 */
export interface SilenceInterval {
  start: number;
  end: number;
  duration: number;
}

/**
 * Resultado de silencedetect sobre un clip individual, en probe/silence.json.
 * `skipped` es true para clips de una lección 'demo': se miden los silencios
 * igual (informativo, para inspección) pero no se usan para proyectar
 * duración porque el silencio ES el contenido de la demo, no aire muerto.
 */
export interface SilenceClip {
  filename: string;
  kind: "demo" | "normal";
  skipped: boolean;
  silences: SilenceInterval[];
  count: number;
  /** Segundos totales de silencio medidos (informativo en demos). */
  totalSilentSeconds: number;
  /** Duración original del clip, en segundos. */
  rawSeconds: number;
  /**
   * Duración proyectada tras recortar el silencio recortable. En demos,
   * projectedSeconds === rawSeconds (no se recorta nada).
   */
  projectedSeconds: number;
  /** projectedSeconds / rawSeconds. En demos siempre 1 (sin recorte). */
  shrinkRatio: number;
}

/** Representación persistida de jobs/<id>/probe/silence.json (etapa 5A). */
export interface SilenceJson {
  generatedAt: string;
  clips: SilenceClip[];
}

/**
 * Un rango de frames a recortar dentro de un CutsClip (etapa 5C), derivado
 * de un hueco de silencio entre segmentos de la transcripción de Whisper.
 * `confirmedBySilence` indica si el corte se solapa con algún intervalo de
 * probe/silence.json de ese clip (doble validación: hueco de Whisper +
 * silencio medido por ffmpeg).
 */
export interface CutRange {
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  gapSeconds: number;
  confirmedBySilence: boolean;
}

/** Un rango de frames a conservar (complemento de los CutRange) en un CutsClip. */
export interface FrameRange {
  startFrame: number;
  endFrame: number;
}

/**
 * Los cortes propuestos para un segmento de clip dentro de una lección, en
 * plan/cuts/<lessonId>.json (etapa 5C). En lecciones 'demo', `cuts` siempre
 * queda vacío y `keep` es el segmento completo (sin recorte de silencio
 * interno).
 */
export interface CutsClip {
  clip: string;
  kind: "demo" | "normal";
  segment: {
    startSeconds: number;
    endSeconds: number;
    startFrame: number;
    endFrame: number;
  };
  cuts: CutRange[];
  keep: FrameRange[];
  stats: {
    cutFrames: number;
    keepFrames: number;
    rawSeconds: number;
    projectedSeconds: number;
  };
}

/**
 * Representación persistida de jobs/<id>/plan/cuts/<lessonId>.json (etapa
 * 5C): los cortes deterministas de todos los segmentos/clips de una lección.
 */
export interface CutsFile {
  lessonId: string;
  lessonTitle: string;
  fps: number;
  generatedAt: string;
  clips: CutsClip[];
}

/* ------------------------------------------------------------------ *
 * Etapas 9 (intros) y 11 (ensamblaje headless)
 * ------------------------------------------------------------------ */

/**
 * Estado de una clase dentro del ensamblaje, usado en
 * progress/assembly-progress.json para reportar avance X/N a la UI.
 * - 'skipped': la clase ya tenía un render verificado y vigente (mismo
 *   fingerprint de entradas), así que no se volvió a renderizar.
 */
export type LessonAssemblyStatus =
  | "pending"
  | "intro"
  | "assembling"
  | "done"
  | "skipped"
  | "error";

/**
 * Representación persistida de jobs/<id>/progress/assembly-progress.json.
 * `lessons` va indexado por lessonId; `backend` deja registrado con qué
 * implementación de AssemblyBackend se corrió (ver assembly/index.ts).
 */
export interface AssemblyProgressJson {
  backend: string;
  total: number;
  lessons: Record<
    string,
    {
      title: string;
      status: LessonAssemblyStatus;
      /** Frames renderizados / totales de la clase (solo mientras corre). */
      frame?: number;
      totalFrames?: number;
      error?: string;
    }
  >;
}

/**
 * Aprobación humana de la estructura del curso (etapa 6, gate): registra
 * cuándo un humano aprobó plan/structure.json tal como está en disco. Se
 * persiste en plan/approval.json; cualquier PUT a structure.json borra este
 * archivo, porque editar la estructura invalida la aprobación anterior.
 */
export interface Approval {
  approvedAt: string;
}

/**
 * Sidecar de verificación escrito junto a cada render:
 * render/<lessonId>.json. Es la ÚNICA fuente de verdad sobre "este MP4 está
 * completo": la existencia del .mp4 no alcanza (un archivo a medio escribir
 * también existe). Solo se escribe DESPUÉS de que ffprobe confirmó el
 * archivo y de que el rename atómico terminó.
 *
 * `sourcesFingerprint` resume las entradas (proxies + cuts + intro) que
 * produjeron este render: si cambia, el render se considera obsoleto y se
 * vuelve a generar; si no, un re-run lo salta sin re-renderizar nada.
 */
export interface RenderSidecar {
  lessonId: string;
  status: "complete";
  backend: string;
  file: string;
  expectedFrames: number;
  actualFrames: number;
  durationSeconds: number;
  sizeBytes: number;
  width: number;
  height: number;
  fps: number;
  hasAudioStream: boolean;
  sourcesFingerprint: string;
  renderedAt: string;
}
