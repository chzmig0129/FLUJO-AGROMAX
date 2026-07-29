/**
 * assembly/ffmpeg/filtergraph.ts — construye el ARGV completo de un único
 * comando ffmpeg que ensambla una clase entera (intro + tramos "keep" +
 * overlays + captions) en una sola pasada, sin shell: todo se arma como un
 * array de argumentos (nunca un string interpolado con rutas) para que rutas
 * con espacios (este mismo repo vive en una con espacio) o backslashes de
 * Windows nunca rompan el parseo de argumentos del proceso.
 *
 * La única parte que SÍ vive dentro de un string (el filtergraph de ffmpeg,
 * que es un mini-lenguaje propio) son los nombres de archivo del filtro
 * `subtitles` (ruta del .ass y del directorio de fuentes): esos se escapan
 * explícitamente con `escapeFilterPath` siguiendo la convención documentada
 * de ffmpeg (barras normales + escapar `:`, `\` y `'`).
 *
 * ESTRATEGIA DE ENTRADAS: cada tramo "keep" recibe su PROPIO `-i` (aunque
 * varios tramos reutilicen el mismo proxy físico), y cada tramo mudo (o el
 * intro, que siempre se renderiza sin audio) recibe un `-i` adicional de
 * `anullsrc` con la duración exacta del tramo — así la salida SIEMPRE tiene
 * una pista de audio continua sin necesitar reusar/`asplit` una fuente
 * compartida entre varias cadenas del filtergraph.
 */
import path from "node:path";
import type { LessonAssemblyPlan, OverlayTimelineItem } from "../types";
import type { FfmpegEncoderName } from "./encoder";
import { encoderOutputArgs } from "./encoder";
import { OVERLAY_FADE_FRAMES } from "../../constants";

/* ------------------------------------------------------------------ *
 * Geometría de overlays — DUPLICADA a propósito de remotion/Overlays.tsx
 * (mismos valores numéricos, ver ese archivo para la justificación de
 * diseño). No se puede importar el .tsx desde este backend sin arrastrar
 * React/JSX a un módulo de Node puro, así que los cuatro números viven acá
 * también, con la misma referencia de issue (FLUJO-AGROMAX-r8q/p8x).
 * ------------------------------------------------------------------ */
const OVERLAY_MARGIN_X = 0.045;
const OVERLAY_MARGIN_Y = 0.045;
const OVERLAY_WIDTH_FRACTION = 0.28;
const OVERLAY_MAX_HEIGHT_FRACTION = 0.42;

/** Duración de un segmento en segundos, con precisión suficiente para no perder frames. */
function framesToSeconds(frames: number, fps: number): string {
  return (frames / fps).toFixed(6);
}

/**
 * Escapa una ruta absoluta para usarla como valor de una opción DENTRO de un
 * filtro de ffmpeg (ej. `subtitles=filename=...`). Convención documentada de
 * ffmpeg: normalizar a `/` (evita el caso particular de la letra de unidad de
 * Windows, "C:"), escapar backslashes y dos puntos, y envolver en comillas
 * simples (escapando comillas simples propias del path, si las hubiera).
 */
export function escapeFilterPath(absPath: string): string {
  const normalized = absPath.split(path.sep).join("/");
  const escaped = normalized.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

interface InputSpec {
  /** Argumentos que preceden a `-i <file>` (ej. -loop 1, -f lavfi). */
  preArgs: string[];
  /** El archivo o descriptor de fuente pasado a `-i`. */
  file: string;
  /** Argumentos que van DESPUÉS de `-i <file>` (ej. -t <duración> de un anullsrc). */
  postArgs: string[];
}

/** Acumulador de inputs: cada `push` devuelve el índice `-i` que le tocó. */
class InputList {
  private specs: InputSpec[] = [];

  push(spec: InputSpec): number {
    this.specs.push(spec);
    return this.specs.length - 1;
  }

  toArgs(): string[] {
    const args: string[] = [];
    for (const spec of this.specs) {
      args.push(...spec.preArgs, "-i", spec.file, ...spec.postArgs);
    }
    return args;
  }
}

/**
 * Fuente de silencio digital, con duración exacta en segundos.
 *
 * OJO CON EL ORDEN: `-t` tiene que ir ANTES del `-i` al que se aplica —
 * ffmpeg asocia cada opción de entrada al PRÓXIMO `-i` que encuentre en el
 * argv, así que un `-t` puesto después de `-i` se interpretaría como opción
 * de la salida (o de la siguiente entrada), no de esta. Por eso acá `-t` vive
 * en `preArgs`, no en `postArgs`.
 */
function anullsrcInput(durationSeconds: string): InputSpec {
  return {
    preArgs: ["-f", "lavfi", "-t", durationSeconds],
    file: `anullsrc=channel_layout=stereo:sample_rate=48000`,
    postArgs: [],
  };
}

export interface AssembleArgsResult {
  /** Argumentos completos para `ffmpeg` (sin el binario), listos para `spawn`. */
  args: string[];
  /** true si el plan incluye un intro realmente presente en disco. */
  hasIntro: boolean;
}

export interface AssembleArgsOptions {
  plan: LessonAssemblyPlan;
  /** Ruta del intro a insertar, o null si el plan no trae uno (o no está en disco). */
  introSourcePath: string | null;
  /** Ruta absoluta del .ass ya escrito (assembly/ffmpeg/ass.ts). */
  assPath: string;
  /** Directorio que contiene el .ttf de Poppins, para `fontsdir` del filtro `subtitles`. */
  fontsDir: string;
  encoder: FfmpegEncoderName;
  /** Ruta de salida (.tmp.mp4), ya resuelta por verify.ts. */
  outputPath: string;
}

/**
 * Construye el ARGV completo de ffmpeg para ensamblar una clase: UN comando,
 * UNA pasada, con `-progress pipe:1` para que el llamador reporte avance.
 */
export function buildAssembleArgs(options: AssembleArgsOptions): AssembleArgsResult {
  const { plan, introSourcePath, assPath, fontsDir, encoder, outputPath } = options;
  const fps = plan.fps;

  const inputs = new InputList();
  // Etiquetas [v?][a?] de cada segmento a concatenar, en orden de salida.
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  const filterChains: string[] = [];

  let introOffsetFrames = 0;

  if (introSourcePath) {
    const introIdx = inputs.push({ preArgs: [], file: introSourcePath, postArgs: [] });
    const introAudioIdx = inputs.push(
      anullsrcInput(framesToSeconds(plan.intro!.durationInFrames, fps))
    );

    filterChains.push(
      `[${introIdx}:v]fps=${fps},scale=${plan.width}:${plan.height},setsar=1,setpts=PTS-STARTPTS[vseg0]`
    );
    filterChains.push(`[${introAudioIdx}:a]asetpts=PTS-STARTPTS[aseg0]`);
    videoLabels.push("vseg0");
    audioLabels.push("aseg0");
    introOffsetFrames = plan.intro!.durationInFrames;
  }

  plan.timeline.forEach((entry) => {
    const segIndex = videoLabels.length; // posición real en la concatenación
    const videoIdx = inputs.push({ preArgs: [], file: entry.sourcePath, postArgs: [] });

    const durationFrames = entry.endFrame - entry.startFrame;
    const startSeconds = framesToSeconds(entry.startFrame, fps);
    const endSeconds = framesToSeconds(entry.endFrame, fps);

    filterChains.push(
      `[${videoIdx}:v]trim=start_frame=${entry.startFrame}:end_frame=${entry.endFrame},setpts=PTS-STARTPTS,fps=${fps},scale=${plan.width}:${plan.height},setsar=1[vseg${segIndex}]`
    );

    if (entry.hasAudio) {
      // Mismo archivo (`entry.sourcePath`) reabierto como -i independiente
      // para su pista de audio: cada `-i` es su propio decodificador, así
      // que no hace falta compartir/`asplit` el pad de video con el de audio.
      const audioIdx = inputs.push({ preArgs: [], file: entry.sourcePath, postArgs: [] });
      filterChains.push(
        `[${audioIdx}:a]atrim=start=${startSeconds}:end=${endSeconds},asetpts=PTS-STARTPTS[aseg${segIndex}]`
      );
    } else {
      const audioIdx = inputs.push(
        anullsrcInput(framesToSeconds(durationFrames, fps))
      );
      filterChains.push(`[${audioIdx}:a]asetpts=PTS-STARTPTS[aseg${segIndex}]`);
    }

    videoLabels.push(`vseg${segIndex}`);
    audioLabels.push(`aseg${segIndex}`);
  });

  // concat: intercala [v][a] por segmento, en el mismo orden que la lista.
  const concatInputs = videoLabels
    .map((v, idx) => `[${v}][${audioLabels[idx]}]`)
    .join("");
  filterChains.push(
    `${concatInputs}concat=n=${videoLabels.length}:v=1:a=1[vcat][acat]`
  );

  // Overlays: se encadenan uno tras otro sobre [vcat], en orden del plan.
  let currentVideoLabel = "vcat";
  plan.overlays.forEach((overlay, idx) => {
    const absPath = path.join(plan.publicRoot, overlay.file);
    const overlayIdx = inputs.push({ preArgs: ["-loop", "1"], file: absPath, postArgs: [] });

    const { displayWidth, displayHeight, left, top } = computeOverlayGeometry(
      overlay,
      plan.width,
      plan.height
    );

    const startSeconds =
      (overlay.startFrame + introOffsetFrames) / fps;
    const endSeconds = (overlay.endFrame + introOffsetFrames) / fps;
    const durationFrames = overlay.endFrame - overlay.startFrame;
    const fadeFrames = Math.max(
      1,
      Math.min(OVERLAY_FADE_FRAMES, Math.floor(durationFrames / 2))
    );
    const fadeSeconds = fadeFrames / fps;
    const fadeOutStart = Math.max(
      startSeconds + fadeSeconds,
      endSeconds - fadeSeconds
    );

    const preppedLabel = `ov${idx}`;
    filterChains.push(
      `[${overlayIdx}:v]scale=${Math.round(displayWidth)}:${Math.round(displayHeight)},format=rgba,` +
        `fade=t=in:st=${startSeconds.toFixed(6)}:d=${fadeSeconds.toFixed(6)}:alpha=1,` +
        `fade=t=out:st=${fadeOutStart.toFixed(6)}:d=${fadeSeconds.toFixed(6)}:alpha=1[${preppedLabel}]`
    );

    const nextLabel = `vov${idx}`;
    filterChains.push(
      `[${currentVideoLabel}][${preppedLabel}]overlay=x=${Math.round(left)}:y=${Math.round(top)}:` +
        `enable='between(t,${startSeconds.toFixed(6)},${endSeconds.toFixed(6)})'[${nextLabel}]`
    );
    currentVideoLabel = nextLabel;
  });

  // Captions: último paso, sobre lo que sea que quedó de video (con o sin
  // overlays) — mismo orden que Lesson.tsx (Captions se monta después de
  // Overlays, así que queda siempre encima).
  filterChains.push(
    `[${currentVideoLabel}]subtitles=filename=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(
      fontsDir
    )}[vout]`
  );

  const filterComplex = filterChains.join(";");

  const args: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    ...inputs.toArgs(),
    "-filter_complex",
    filterComplex,
    "-map",
    "[vout]",
    "-map",
    "[acat]",
    ...encoderOutputArgs(encoder),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    outputPath,
  ];

  return { args, hasIntro: introSourcePath !== null };
}

/** Geometría de display (px) y posición (px, esquina superior izquierda) de un overlay. */
export function computeOverlayGeometry(
  overlay: OverlayTimelineItem,
  planWidth: number,
  planHeight: number
): { displayWidth: number; displayHeight: number; left: number; top: number } {
  let displayWidth = OVERLAY_WIDTH_FRACTION * planWidth;
  let displayHeight = displayWidth * overlay.aspect;
  const maxHeight = OVERLAY_MAX_HEIGHT_FRACTION * planHeight;
  if (displayHeight > maxHeight) {
    displayHeight = maxHeight;
    displayWidth = displayHeight / overlay.aspect;
  }
  const left = planWidth * OVERLAY_MARGIN_X;
  const top = planHeight * OVERLAY_MARGIN_Y;
  return { displayWidth, displayHeight, left, top };
}
