/**
 * assembly/plan.ts — el planner del ensamblaje: traduce lo que ya existe en
 * disco (plan/structure.json + plan/cuts/<lessonId>.json + assets/proxies/)
 * a un LessonAssemblyPlan por clase, listo para que CUALQUIER backend lo
 * ejecute.
 *
 * Este módulo no renderiza nada y no sabe qué backend está activo. Es donde
 * viven las tres traducciones delicadas:
 *
 *   1. clip → proxy. structure.json nombra el archivo FUENTE (ej.
 *      "video_sin_audio.MOV") pero el ensamblaje SIEMPRE consume el proxy
 *      normalizado 1080p/30 (assets/proxies/video_sin_audio.mp4), con la
 *      misma regla de nombre que usa proxy-stage.ts (basename sin extensión
 *      + ".mp4"). Si el proxy falta, se falla acá con un mensaje claro en
 *      vez de dejar que un backend explote a mitad de un render.
 *
 *   2. keep → timeline. Los rangos "keep" de la etapa 5C YA vienen
 *      calculados y particionan cada segmento sin huecos ni traslapes: se
 *      usan tal cual, en orden, sin recalcular ni un solo corte. Concatenar
 *      solo esos tramos ES el ripple/quita-silencios.
 *
 *   3. duración esperada. expectedFrames = intro + Σ(endFrame - startFrame).
 *      Como los proxies son CFR a PROXY_FPS, un frame N equivale exactamente
 *      a N/fps segundos: no hay redondeo ni deriva acumulada entre tramos.
 *      Este número es después el contrato contra el que se verifica el MP4.
 *
 * INVARIANTE: solo lee. No escribe nada en el job.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffprobePath } from "../probe";
import {
  INTRO_DURATION_FRAMES,
  PROXY_FPS,
  PROXY_HEIGHT,
  PROXY_WIDTH,
} from "../constants";
import {
  assetsDir,
  cutsDir,
  introPath,
  proxiesDir,
  readCutsFiles,
  readStructureJson,
  renderPath,
} from "../jobs";
import type {
  Caption,
  CaptionsFile,
  IntroProps,
  LessonAssemblyPlan,
  OverlayTimelineFile,
  OverlayTimelineItem,
  TimelineEntry,
} from "./types";

const execFileAsync = promisify(execFile);

/** Datos de una clase que el ensamblaje necesita, ya aplanados de structure.json. */
export interface PlannedLesson {
  lessonId: string;
  lessonTitle: string;
  kind: "demo" | "normal";
  introProps: IntroProps;
  plan: LessonAssemblyPlan;
}

/**
 * Nombre del proxy correspondiente a un clip fuente. Misma regla que
 * proxy-stage.ts (`proxyOutPath`): basename sin extensión + ".mp4". Si las
 * dos reglas se separan, el ensamblaje deja de encontrar proxies — por eso
 * queda documentado en ambos lados.
 */
function proxyFileName(clip: string): string {
  return `${path.basename(clip, path.extname(clip))}.mp4`;
}

/**
 * Indica si un archivo de video tiene pista de audio, preguntándole a
 * ffprobe sobre el PROXY (no sobre el source): el proxy de un clip mudo
 * tampoco tiene pista, y es el proxy lo que se ensambla. Ante cualquier
 * error de ffprobe se asume `false`, que es el lado seguro: el backend
 * tratará el tramo como mudo y rellenará silencio, en vez de pedirle a un
 * archivo un stream de audio inexistente.
 */
async function probeHasAudio(file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      file,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Lee plan/captions/<lessonId>.json con fs directo (SIN pasar por jobs.ts,
 * para no acoplar el planner a esos helpers: es otro worker quien produce
 * ese archivo, en paralelo). Tolerante: si el archivo no existe o no
 * parsea, devuelve `[]` y el ensamblaje sigue sin subtítulos en vez de
 * fallar — la etapa de captions es best-effort respecto al ensamblaje.
 */
async function readCaptionsFile(
  jobId: string,
  lessonId: string
): Promise<Caption[]> {
  const captionsFile = path.join(
    path.dirname(cutsDir(jobId)),
    "captions",
    `${lessonId}.json`
  );
  try {
    const raw = await fs.readFile(captionsFile, "utf8");
    const parsed = JSON.parse(raw) as CaptionsFile;
    return Array.isArray(parsed?.captions) ? parsed.captions : [];
  } catch {
    return [];
  }
}

/**
 * Lee plan/overlays-timeline/<lessonId>.json con fs directo (mismo patrón
 * tolerante que `readCaptionsFile`, otro worker/etapa produce ese archivo,
 * en paralelo). Si el archivo no existe o no parsea, devuelve `[]` y el
 * ensamblaje sigue sin overlays en vez de fallar — la etapa de timeline de
 * overlays es best-effort respecto al ensamblaje.
 */
async function readOverlaysTimelineFile(
  jobId: string,
  lessonId: string
): Promise<OverlayTimelineItem[]> {
  const overlaysTimelineFile = path.join(
    path.dirname(cutsDir(jobId)),
    "overlays-timeline",
    `${lessonId}.json`
  );
  try {
    const raw = await fs.readFile(overlaysTimelineFile, "utf8");
    const parsed = JSON.parse(raw) as OverlayTimelineFile;
    return Array.isArray(parsed?.overlays) ? parsed.overlays : [];
  } catch {
    return [];
  }
}

/**
 * Huella de las entradas de una clase: mtime+tamaño de cada proxy usado, del
 * archivo de cortes y del intro. Es lo que permite que un re-run salte las
 * clases ya renderizadas SIN re-transcodificar ni re-cortar, pero vuelva a
 * renderizar en cuanto una entrada real cambió (por ejemplo tras re-correr
 * la preparación con otro `kind`).
 */
async function fingerprintSources(
  files: string[]
): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      parts.push(`${path.basename(file)}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    } catch {
      // Un archivo ausente también es parte de la huella: si después
      // aparece, la huella cambia y el render se rehace.
      parts.push(`${path.basename(file)}:missing`);
    }
  }
  return parts.join("|");
}

/**
 * Construye los planes de ensamblaje de TODAS las clases de un job, en el
 * orden en que aparecen en la estructura (módulo, luego lección).
 *
 * Lanza si falta structure.json, si una clase no tiene su archivo de cortes,
 * si falta el proxy de algún segmento o si el timeline queda vacío: todos
 * esos casos significan que la preparación (5A/5B/5C) no está completa, y es
 * mucho mejor decirlo acá que producir un MP4 mutilado.
 */
export async function buildAssemblyPlans(
  jobId: string
): Promise<PlannedLesson[]> {
  const structure = await readStructureJson(jobId);
  if (!structure) {
    throw new Error(
      `No se puede ensamblar: falta plan/structure.json del job "${jobId}" (¿ya corrió la etapa de plan?)`
    );
  }

  const cutsFiles = await readCutsFiles(jobId);
  const cutsByLesson = new Map(cutsFiles.map((c) => [c.lessonId, c]));

  const publicRoot = assetsDir(jobId);
  const planned: PlannedLesson[] = [];

  // Cache de "¿este proxy tiene audio?" para no ffprobear el mismo archivo
  // una vez por cada tramo keep (una clase puede tener decenas).
  const audioCache = new Map<string, boolean>();

  const modules = [...structure.modules].sort((a, b) => a.order - b.order);

  for (const module of modules) {
    const lessons = [...module.lessons].sort((a, b) => a.order - b.order);

    for (const lesson of lessons) {
      const cuts = cutsByLesson.get(lesson.id);
      if (!cuts) {
        throw new Error(
          `No se puede ensamblar la clase "${lesson.id}": falta plan/cuts/${lesson.id}.json (corre la preparación primero)`
        );
      }

      const timeline: TimelineEntry[] = [];
      const usedProxies = new Set<string>();

      for (const clipCuts of cuts.clips) {
        const proxyFile = path.join(
          proxiesDir(jobId),
          proxyFileName(clipCuts.clip)
        );

        try {
          await fs.access(proxyFile);
        } catch {
          throw new Error(
            `No se puede ensamblar la clase "${lesson.id}": falta el proxy ${path.basename(proxyFile)} del clip "${clipCuts.clip}" (corre la etapa de proxies)`
          );
        }

        let hasAudio = audioCache.get(proxyFile);
        if (hasAudio === undefined) {
          hasAudio = await probeHasAudio(proxyFile);
          audioCache.set(proxyFile, hasAudio);
        }
        usedProxies.add(proxyFile);

        // Los rangos "keep" se usan TAL CUAL, en orden: ya particionan el
        // segmento y ya son el resultado del quita-silencios.
        for (const keep of clipCuts.keep) {
          const duration = keep.endFrame - keep.startFrame;
          if (duration <= 0) continue;
          timeline.push({
            clip: clipCuts.clip,
            sourcePath: proxyFile,
            publicRelPath: path.relative(publicRoot, proxyFile),
            startFrame: keep.startFrame,
            endFrame: keep.endFrame,
            hasAudio,
          });
        }
      }

      if (timeline.length === 0) {
        throw new Error(
          `No se puede ensamblar la clase "${lesson.id}": no quedó ningún tramo "keep" para concatenar`
        );
      }

      const introFile = introPath(jobId, lesson.id);
      const keepFrames = timeline.reduce(
        (sum, entry) => sum + (entry.endFrame - entry.startFrame),
        0
      );

      const fingerprint = await fingerprintSources([
        ...usedProxies,
        path.join(cutsDir(jobId), `${lesson.id}.json`),
      ]);

      const moduleLabel = `MÓDULO ${module.order} · CLASE ${lesson.order}`;
      const subtitle = lesson.segments[0]?.topic ?? "";
      const captions = await readCaptionsFile(jobId, lesson.id);
      const overlays = await readOverlaysTimelineFile(jobId, lesson.id);

      planned.push({
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        kind: lesson.kind ?? "normal",
        introProps: {
          title: lesson.title,
          moduleLabel,
          kicker: structure.courseTitle,
          subtitle,
        },
        plan: {
          jobId,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          kind: lesson.kind ?? "normal",
          fps: PROXY_FPS,
          width: PROXY_WIDTH,
          height: PROXY_HEIGHT,
          publicRoot,
          intro: {
            sourcePath: introFile,
            publicRelPath: path.relative(publicRoot, introFile),
            durationInFrames: INTRO_DURATION_FRAMES,
          },
          timeline,
          captions,
          overlays,
          expectedFrames: INTRO_DURATION_FRAMES + keepFrames,
          outputPath: renderPath(jobId, lesson.id),
          // El intro se agrega a la huella recién en assembly-stage.ts,
          // cuando ya fue renderizado (antes de eso su mtime no existe).
          sourcesFingerprint: fingerprint,
        },
      });
    }
  }

  return planned;
}

/**
 * Recalcula la huella de una clase incluyendo el intro ya renderizado. Se
 * llama después de la etapa 9 y antes del ensamblaje, para que un intro
 * regenerado también invalide el render de la clase.
 */
export async function fingerprintWithIntro(
  plan: LessonAssemblyPlan
): Promise<string> {
  const introFingerprint = plan.intro
    ? await fingerprintSources([plan.intro.sourcePath])
    : "no-intro";
  return `${plan.sourcesFingerprint}|intro:${introFingerprint}`;
}
