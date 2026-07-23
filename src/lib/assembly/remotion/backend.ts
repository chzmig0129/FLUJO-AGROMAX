/**
 * assembly/remotion/backend.ts — implementación de AssemblyBackend sobre
 * Remotion headless. Es el backend por DEFECTO (ASSEMBLY_BACKEND=remotion):
 * corre en servidor, sin GUI, y escala lanzando más procesos.
 *
 * Es la ÚNICA parte del sistema que sabe que Remotion existe. Todo lo que
 * entra acá ya viene resuelto en un LessonAssemblyPlan (rutas + timeline en
 * frames + duración esperada); todo lo que sale es un RenderArtifact ya
 * verificado.
 *
 * DOS DETALLES DE INTEGRACIÓN QUE VALE LA PENA ENTENDER:
 *
 * 1. publicDir por job + symlink. Remotion sirve los assets por HTTP desde
 *    el "public dir" que se hornea en el bundle, y las composiciones los
 *    piden con staticFile("proxies/x.mp4"). Se bundlea con
 *    publicDir = jobs/<id>/assets y symlinkPublicDir: true — con symlink,
 *    NO se copian los proxies (que pesan GB) dentro del bundle. El bundle se
 *    hace UNA vez por job y se reutiliza para el intro y todas las clases.
 *
 * 2. Se escribe siempre al .tmp y la promoción a la ruta final la hace
 *    verify.ts tras ffprobear el archivo. Este módulo nunca renombra ni
 *    declara nada "completo" por su cuenta.
 */
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type {
  AssemblyBackend,
  IntroRenderInput,
  LessonAssemblyPlan,
  LessonCompositionProps,
  RenderArtifact,
  RenderProgress,
} from "../types";
import { tempPathFor, verifyAndCommit } from "../verify";

/** Entrypoint del bundle de Remotion (remotion/index.ts en la raíz del repo). */
const ENTRY_POINT = path.join(process.cwd(), "remotion", "index.ts");

/**
 * Bundles ya construidos, cacheados por directorio público (es decir, por
 * job). Vive en memoria del proceso: bundlear es lo caro de Remotion y no
 * tiene sentido repetirlo por clase.
 */
const bundleCache = new Map<string, Promise<string>>();

/** Construye (o reutiliza) el bundle de Remotion para el public dir de un job. */
function getBundle(publicDir: string): Promise<string> {
  const cached = bundleCache.get(publicDir);
  if (cached) return cached;

  const created = (async () => {
    const outDir = path.join(
      os.tmpdir(),
      `agromax-remotion-${path.basename(path.dirname(publicDir))}-${process.pid}`
    );
    // Un bundle viejo del mismo job (por ejemplo de una corrida anterior en
    // este mismo proceso) se descarta: el symlink al public dir no se puede
    // recrear sobre un directorio existente.
    await fs.rm(outDir, { recursive: true, force: true });

    return bundle({
      entryPoint: ENTRY_POINT,
      outDir,
      publicDir,
      // Sin symlink, Remotion COPIARÍA todos los proxies al bundle.
      symlinkPublicDir: true,
      onProgress: () => {},
    });
  })();

  bundleCache.set(publicDir, created);
  return created;
}

/**
 * Descarta el bundle cacheado de `publicDir`, si existe. La próxima llamada a
 * `getBundle` para ese mismo `publicDir` vuelve a bundlear desde cero.
 *
 * Necesario en Windows: sin Developer Mode, `symlinkPublicDir` falla y
 * Remotion COPIA `publicDir` al bundlear en vez de symlinkearlo, así que el
 * primer bundle (típicamente el del intro, cuando assets/intros/ todavía
 * está vacío) queda congelado sin los assets generados después. Se llama
 * entre la pasada de intros y la de ensamblaje para forzar un bundle nuevo
 * con el public/ completo.
 */
export function clearBundleCache(publicDir: string): void {
  bundleCache.delete(publicDir);
}

/** Normaliza separadores de Windows a "/" para que staticFile() los entienda. */
function toPublicUrlPath(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

/**
 * Opciones de renderMedia configurables por env, pensadas para blindar contra
 * caídas del compositor en clases largas (muchos assets: overlays PNG +
 * captions + audio). Sin estas, el timeout por defecto de Remotion (30s) se
 * agota esperando el proxy de OffthreadVideo en videos largos, y una
 * concurrencia alta (= f(cores)) puede reventar la pestaña del compositor por
 * presión de memoria en máquinas modestas. Se usan tanto para el render de la
 * clase como para el del intro.
 */
function buildRenderMediaTuning(): {
  timeoutInMilliseconds: number;
  concurrency?: number;
  offthreadVideoCacheSizeInBytes?: number;
} {
  const timeoutInMilliseconds = Number(process.env.REMOTION_TIMEOUT_MS) || 120_000;

  const tuning: {
    timeoutInMilliseconds: number;
    concurrency?: number;
    offthreadVideoCacheSizeInBytes?: number;
  } = { timeoutInMilliseconds };

  if (process.env.REMOTION_CONCURRENCY) {
    tuning.concurrency = Number(process.env.REMOTION_CONCURRENCY);
  }

  if (process.env.REMOTION_OFFTHREAD_CACHE_BYTES) {
    tuning.offthreadVideoCacheSizeInBytes = Number(
      process.env.REMOTION_OFFTHREAD_CACHE_BYTES
    );
  }

  return tuning;
}

/**
 * Renderiza una composición al .tmp de `outputPath`. No verifica ni
 * promueve: eso lo hace el llamador con verify.ts.
 */
async function renderToTemp(options: {
  serveUrl: string;
  compositionId: string;
  inputProps: Record<string, unknown>;
  outputPath: string;
  onProgress?: (p: RenderProgress) => void;
}): Promise<{ tmpPath: string; durationInFrames: number }> {
  const tmpPath = tempPathFor(options.outputPath);
  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.rm(tmpPath, { force: true });

  const composition = await selectComposition({
    serveUrl: options.serveUrl,
    id: options.compositionId,
    inputProps: options.inputProps,
  });

  try {
    await renderMedia({
      composition,
      serveUrl: options.serveUrl,
      codec: "h264",
      audioCodec: "aac",
      inputProps: options.inputProps,
      outputLocation: tmpPath,
      // La salida SIEMPRE lleva pista de audio, aunque todos los tramos
      // fueran mudos: así ningún consumidor posterior (overlays, subtítulos,
      // concatenaciones) se topa con un MP4 sin audio.
      enforceAudioTrack: true,
      ...buildRenderMediaTuning(),
      onProgress: ({ renderedFrames }) => {
        options.onProgress?.({
          frame: renderedFrames,
          totalFrames: composition.durationInFrames,
        });
      },
    });
  } catch (err) {
    // Un render abortado no debe dejar basura ocupando espacio ni confundir
    // a la próxima corrida.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  return { tmpPath, durationInFrames: composition.durationInFrames };
}

export const remotionBackend: AssemblyBackend = {
  name: "remotion",

  async isAvailable() {
    try {
      await fs.access(ENTRY_POINT);
    } catch {
      return {
        ok: false,
        reason: `No se encontró el entrypoint de Remotion en ${ENTRY_POINT}`,
      };
    }
    return { ok: true };
  },

  /** Etapa 9: un intro por clase, determinista, sin audio. */
  async renderIntro(input: IntroRenderInput, onProgress) {
    const serveUrl = await getBundle(input.publicRoot);

    await renderToTemp({
      serveUrl,
      compositionId: "Intro",
      inputProps: { ...input.props },
      outputPath: input.outputPath,
      onProgress,
    });

    const probed = await verifyAndCommit(input.outputPath, {
      expectedFrames: input.durationInFrames,
      width: input.width,
      height: input.height,
      fps: input.fps,
      // El intro no necesita audio propio; el ensamblaje de la clase le
      // aporta la pista continua a la salida final.
      requireAudio: false,
    });

    return {
      path: input.outputPath,
      backend: "remotion",
      frames: probed.packetCount,
      durationSeconds: probed.durationSeconds,
      sizeBytes: probed.sizeBytes,
      renderedAt: new Date().toISOString(),
    } satisfies RenderArtifact;
  },

  /** Etapa 11: intro + tramos "keep" concatenados, verificado y promovido. */
  async assembleLesson(plan: LessonAssemblyPlan, onProgress) {
    const serveUrl = await getBundle(plan.publicRoot);

    // El intro se inserta solo si de verdad existe en disco: una clase sin
    // intro renderizado se ensambla igual (sin él) en vez de fallar.
    let introSrc: string | null = null;
    if (plan.intro) {
      try {
        await fs.access(plan.intro.sourcePath);
        introSrc = toPublicUrlPath(plan.intro.publicRelPath);
      } catch {
        introSrc = null;
      }
    }

    const inputProps: LessonCompositionProps = {
      introSrc,
      introDurationInFrames: plan.intro?.durationInFrames ?? 0,
      entries: plan.timeline.map((entry) => ({
        src: toPublicUrlPath(entry.publicRelPath),
        startFrame: entry.startFrame,
        endFrame: entry.endFrame,
        hasAudio: entry.hasAudio,
      })),
      captions: plan.captions.map((caption) => ({
        text: caption.text,
        startFrame: caption.startFrame,
        endFrame: caption.endFrame,
        words: caption.words.map((word) => ({
          text: word.text,
          startFrame: word.startFrame,
          endFrame: word.endFrame,
        })),
      })),
      overlays: plan.overlays.map((overlay) => ({
        key: overlay.key,
        file: toPublicUrlPath(overlay.file),
        startFrame: overlay.startFrame,
        endFrame: overlay.endFrame,
        aspect: overlay.aspect,
      })),
    };

    const { durationInFrames } = await renderToTemp({
      serveUrl,
      compositionId: "Lesson",
      inputProps: inputProps as unknown as Record<string, unknown>,
      outputPath: plan.outputPath,
      onProgress,
    });

    // Si el intro no estaba en disco, la duración real de la composición es
    // menor que plan.expectedFrames: se verifica contra lo que la
    // composición realmente declaró, que sigue siendo un número derivado del
    // plan (no del archivo producido).
    const expectedFrames = introSrc
      ? plan.expectedFrames
      : plan.expectedFrames - (plan.intro?.durationInFrames ?? 0);

    if (durationInFrames !== expectedFrames) {
      throw new Error(
        `Inconsistencia de plan en "${plan.lessonId}": la composición declaró ${durationInFrames} frames y el plan esperaba ${expectedFrames}`
      );
    }

    const probed = await verifyAndCommit(plan.outputPath, {
      expectedFrames,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      requireAudio: true,
    });

    return {
      path: plan.outputPath,
      backend: "remotion",
      frames: probed.packetCount,
      durationSeconds: probed.durationSeconds,
      sizeBytes: probed.sizeBytes,
      renderedAt: new Date().toISOString(),
    } satisfies RenderArtifact;
  },

  invalidateBundleCache(publicRoot: string) {
    clearBundleCache(publicRoot);
  },
};
