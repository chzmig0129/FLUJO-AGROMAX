/**
 * assembly/types.ts — el CONTRATO del ensamblaje. Este archivo es el corazón
 * del principio "backend de ensamblaje intercambiable": describe qué recibe
 * y qué devuelve un backend, sin mencionar jamás a Remotion, a ffmpeg ni a
 * Palmier.
 *
 * IDEA CENTRAL: el backend NO conoce el job.
 *
 *   plan/structure.json + plan/cuts/<lessonId>.json
 *          │
 *          ▼   (assembly/plan.ts — puro, sin render)
 *   LessonAssemblyPlan   ← rutas ya resueltas + timeline ya expandido en frames
 *          │
 *          ▼   (AssemblyBackend — remotion | palmier)
 *   render/<lessonId>.mp4
 *
 * Todo lo interesante y frágil (resolver clip→proxy, expandir los rangos
 * "keep", calcular la duración esperada) ocurre UNA sola vez en el planner y
 * queda congelado en el plan. Un backend nuevo solo tiene que saber ejecutar
 * ese plan: no re-lee structure.json, no re-calcula cortes, no adivina rutas.
 * Por eso agregar Palmier mañana es escribir dos métodos, no un pipeline.
 */

/**
 * Un tramo de video a concatenar, ya resuelto a un archivo concreto y a un
 * rango de frames dentro de ese archivo.
 *
 * CONVENCIÓN DE FRAMES: [startFrame, endFrame) — semiabierto, igual que los
 * FrameRange de la etapa 5C (ver cuts-stage.ts). La duración del tramo es
 * exactamente endFrame - startFrame.
 *
 * Se dan DOS formas de la misma ruta a propósito:
 *  - `sourcePath`: absoluta. La usa cualquier backend que invoque un binario
 *    (ffmpeg, un editor externo, Palmier).
 *  - `publicRelPath`: relativa a `publicRoot` del plan. La usa un backend web
 *    (Remotion) que sirve los assets por HTTP desde un directorio público.
 * Ambas apuntan al mismo archivo; ningún backend necesita derivar una de la
 * otra.
 */
export interface TimelineEntry {
  /** Nombre del clip fuente original (para trazabilidad/logs). */
  clip: string;
  /** Ruta absoluta al proxy 1080p/30 de ese clip. */
  sourcePath: string;
  /** Ruta del mismo archivo relativa a `publicRoot` (ej. "proxies/x.mp4"). */
  publicRelPath: string;
  /** Primer frame conservado (inclusivo), relativo al inicio del proxy. */
  startFrame: number;
  /** Frame final (exclusivo), relativo al inicio del proxy. */
  endFrame: number;
  /**
   * true si el proxy tiene pista de audio. Los proxies de clips mudos NO la
   * tienen (ver proxy-stage.ts), y ese caso debe concatenar limpio junto a
   * los clips con audio: el backend es responsable de que la salida tenga
   * UNA sola pista de audio continua, rellenando con silencio donde haga
   * falta.
   */
  hasAudio: boolean;
}

/**
 * Props del intro de una clase (etapa 9). Son puramente de presentación:
 * salen de structure.json y no dependen de ningún backend.
 */
export type IntroProps = {
  /** Título de la clase. */
  title: string;
  /** Etiqueta de posición, ej. "MÓDULO 2 · CLASE 3". */
  moduleLabel: string;
  /** Kicker del curso, arriba del título. */
  kicker: string;
  /** Subtítulo (tema principal de la clase); vacío si no aplica. */
  subtitle: string;
};

/** Lo que un backend necesita para producir el intro de una clase. */
export interface IntroRenderInput {
  jobId: string;
  lessonId: string;
  props: IntroProps;
  /** Mismo publicRoot que el plan de la clase (jobs/<id>/assets). */
  publicRoot: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  /** Ruta absoluta de salida: assets/intros/<lessonId>.mp4. */
  outputPath: string;
}

/**
 * El plan de ensamblaje de UNA clase: entrada completa y autosuficiente del
 * método `assembleLesson` de cualquier backend.
 */
export interface LessonAssemblyPlan {
  jobId: string;
  lessonId: string;
  lessonTitle: string;
  /** 'demo' se ensambla igual que 'normal': su cuts file no tiene cortes internos. */
  kind: "demo" | "normal";
  fps: number;
  width: number;
  height: number;
  /**
   * Directorio raíz desde el que se sirven/leen los assets del job
   * (jobs/<id>/assets). `publicRelPath` de las entradas y del intro son
   * relativos a este directorio.
   */
  publicRoot: string;
  /** Intro de la etapa 9 insertado en el frame 0; null si la clase no lleva. */
  intro: {
    sourcePath: string;
    publicRelPath: string;
    durationInFrames: number;
  } | null;
  /** Tramos "keep" en orden. Ya expandidos: el backend NO recalcula cortes. */
  timeline: TimelineEntry[];
  /** intro + Σ(endFrame - startFrame). Es el contrato de verificación. */
  expectedFrames: number;
  /** Ruta absoluta de salida final: render/<lessonId>.mp4. */
  outputPath: string;
  /**
   * Huella de las entradas (proxies + cuts + intro). Si cambia, el render
   * guardado quedó obsoleto; si no, un re-run puede saltarse esta clase.
   */
  sourcesFingerprint: string;
}

/** Resultado verificado de un render individual (intro o clase). */
export interface RenderArtifact {
  path: string;
  backend: string;
  frames: number;
  durationSeconds: number;
  sizeBytes: number;
  renderedAt: string;
}

/** Reporte de progreso mientras un backend renderiza. */
export interface RenderProgress {
  frame: number;
  totalFrames: number;
}

/**
 * LA interfaz intercambiable. Un backend es exactamente esto: "dado el plan
 * de una clase, produce su MP4" (más el intro, que es el mismo problema en
 * chico). Nada más entra acá: ni progreso persistido, ni job.json, ni
 * políticas de re-corrida — eso vive en assembly-stage.ts, que es común a
 * todos los backends.
 */
export interface AssemblyBackend {
  /** Identificador estable, se persiste en el sidecar y en el progreso. */
  readonly name: string;

  /**
   * Chequeo barato de disponibilidad (binarios/paquetes presentes). Permite
   * fallar temprano y con un mensaje claro en vez de a mitad de un render.
   */
  isAvailable(): Promise<{ ok: boolean; reason?: string }>;

  /** Etapa 9: renderiza el intro de una clase a `input.outputPath`. */
  renderIntro(
    input: IntroRenderInput,
    onProgress?: (p: RenderProgress) => void
  ): Promise<RenderArtifact>;

  /** Etapa 11: ensambla la clase completa a `plan.outputPath`. */
  assembleLesson(
    plan: LessonAssemblyPlan,
    onProgress?: (p: RenderProgress) => void
  ): Promise<RenderArtifact>;
}

/**
 * Props que recibe la composición "Lesson" de Remotion. Vive acá (y no en
 * remotion/) para que el planner y la composición compartan un único tipo y
 * no se desincronicen; es un tipo de datos plano, sin dependencias de React.
 *
 * Es un `type` y no un `interface` a propósito: Remotion exige que las props
 * de una composición sean asignables a Record<string, unknown>, y solo los
 * type aliases tienen index signature implícita. Lo mismo vale para
 * IntroProps.
 */
export type LessonCompositionProps = {
  /** Ruta del intro relativa a publicRoot, o null si no lleva intro. */
  introSrc: string | null;
  introDurationInFrames: number;
  /** Tramos keep, en orden, ya relativos a publicRoot. */
  entries: Array<{
    src: string;
    startFrame: number;
    endFrame: number;
    hasAudio: boolean;
  }>;
};
