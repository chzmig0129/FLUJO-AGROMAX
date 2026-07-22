/**
 * assembly-stage.ts — etapas 9 (intros) y 11 (ensamblaje headless) del
 * pipeline: por primera vez el sistema produce un MP4 por lección, en
 * jobs/<id>/render/<lessonId>.mp4.
 *
 * Esta etapa es AGNÓSTICA del backend: pide el backend activo a
 * assembly/index.ts y solo habla con la interfaz AssemblyBackend. Todo lo
 * que no es "producir píxeles" vive acá y se comparte entre backends:
 * progreso X/N, política de re-corrida, sidecars y job.json.
 *
 * FLUJO POR CLASE (secuencial entre clases, para no pelear por CPU: cada
 * render de Remotion ya paraleliza internamente por frames):
 *   1. Etapa 9 — intro a assets/intros/<lessonId>.mp4 (si falta o cambió).
 *   2. Etapa 11 — intro + tramos "keep" a render/<lessonId>.mp4.
 *   3. Verificación + sidecar (en assembly/verify.ts).
 *
 * RE-CORRIBLE SIN RE-TRANSCODIFICAR NI RE-CORTAR: nada acá toca source/,
 * assets/proxies/ ni plan/cuts/. Si una clase ya tiene un sidecar 'complete'
 * con la misma huella de entradas, se salta y se marca 'skipped'.
 *
 * INVARIANTE: los renders van SOLO a render/ y los intros SOLO a
 * assets/intros/. source/ y proxies quedan intactos.
 */
import { promises as fs } from "node:fs";
import { getAssemblyBackend } from "./assembly";
import { buildAssemblyPlans, fingerprintWithIntro } from "./assembly/plan";
import type { PlannedLesson } from "./assembly/plan";
import { INTRO_DURATION_FRAMES } from "./constants";
import {
  introPath,
  introsDir,
  readRenderSidecar,
  renderDir,
  updateJobStatus,
  writeAssemblyProgressJson,
  writeRenderSidecar,
} from "./jobs";
import type { AssemblyProgressJson, RenderSidecar } from "./types";

/**
 * Decide si el intro de una clase necesita re-renderizarse. El intro es
 * determinista y sus props salen de structure.json, así que basta con que
 * exista: si structure.json cambió, la etapa de plan lo regeneró y el
 * usuario re-corre el ensamblaje con `force`.
 */
async function introExists(jobId: string, lessonId: string): Promise<boolean> {
  try {
    await fs.access(introPath(jobId, lessonId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide si una clase puede saltarse: hace falta un sidecar 'complete', que
 * el MP4 siga en disco, y que la huella de entradas coincida. Cualquier duda
 * ⇒ re-renderizar (es más barato que entregar un video viejo o mutilado).
 */
async function canSkip(
  jobId: string,
  lessonId: string,
  fingerprint: string
): Promise<RenderSidecar | null> {
  const sidecar = await readRenderSidecar(jobId, lessonId);
  if (!sidecar) return null;
  if (sidecar.sourcesFingerprint !== fingerprint) return null;
  try {
    await fs.access(sidecar.file);
  } catch {
    return null;
  }
  return sidecar;
}

/**
 * Corre las etapas 9 y 11 completas para un job ya preparado.
 *
 * @param force si es true, ignora los sidecars y re-renderiza todas las
 *   clases (incluyendo los intros).
 */
export async function runAssemblyStage(
  jobId: string,
  options?: { force?: boolean }
): Promise<void> {
  const force = options?.force ?? false;
  const backend = getAssemblyBackend();

  const availability = await backend.isAvailable();
  if (!availability.ok) {
    throw new Error(
      `El backend de ensamblaje "${backend.name}" no está disponible: ${availability.reason ?? "razón desconocida"}`
    );
  }

  // El planner falla temprano y con mensaje claro si falta cualquier
  // prerequisito (structure.json, cuts, proxies).
  const planned: PlannedLesson[] = await buildAssemblyPlans(jobId);

  await fs.mkdir(introsDir(jobId), { recursive: true });
  await fs.mkdir(renderDir(jobId), { recursive: true });

  // Estado inicial del progreso: todas las clases pendientes, para que la UI
  // pueda mostrar X/N desde el primer poll.
  const progress: AssemblyProgressJson = {
    backend: backend.name,
    total: planned.length,
    lessons: Object.fromEntries(
      planned.map((lesson) => [
        lesson.lessonId,
        { title: lesson.lessonTitle, status: "pending" as const },
      ])
    ),
  };

  // Cola de escrituras del progreso (mismo patrón que proxy-stage.ts): las
  // escrituras se serializan para que dos updates seguidos no se pisen.
  let writeQueue: Promise<void> = Promise.resolve();
  const persist = () => {
    const snapshot: AssemblyProgressJson = {
      ...progress,
      lessons: { ...progress.lessons },
    };
    writeQueue = writeQueue
      .then(() => writeAssemblyProgressJson(jobId, snapshot))
      .catch(() => {});
    return writeQueue;
  };

  await persist();

  const startedAt = new Date().toISOString();
  await updateJobStatus(jobId, "assembling", {
    stages: {
      intros: { startedAt },
      assembly: { startedAt },
    },
  });

  const failures: string[] = [];

  // Clases cuyo intro falló en la primera pasada: se saltan en la segunda
  // (su error ya quedó registrado) en vez de intentar ensamblarlas sin él.
  const introFailed = new Set<string>();

  /* ============ PRIMERA PASADA — etapa 9: TODOS los intros ============
   * Se renderizan todos los intros faltantes antes de tocar el ensamblaje
   * de ninguna clase. Motivo (bug de Windows): sin Developer Mode,
   * symlinkPublicDir falla y el bundler de Remotion COPIA public/ al primer
   * getBundle. Si esa primera vez ocurriera durante un renderIntro con
   * assets/intros/ todavía incompleto, el bundle cacheado en memoria
   * quedaría congelado sin los intros para todo el resto del job.
   * Terminando esta pasada primero, assets/intros/ ya tiene todo lo que va
   * a tener antes de que exista cualquier bundle de la fase de clases. */
  for (const lesson of planned) {
    const entry = progress.lessons[lesson.lessonId];

    try {
      if (force || !(await introExists(jobId, lesson.lessonId))) {
        entry.status = "intro";
        await persist();

        await backend.renderIntro({
          jobId,
          lessonId: lesson.lessonId,
          props: lesson.introProps,
          publicRoot: lesson.plan.publicRoot,
          fps: lesson.plan.fps,
          width: lesson.plan.width,
          height: lesson.plan.height,
          durationInFrames: INTRO_DURATION_FRAMES,
          outputPath: introPath(jobId, lesson.lessonId),
        });
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Error desconocido al renderizar el intro";
      entry.status = "error";
      entry.error = message;
      introFailed.add(lesson.lessonId);
      failures.push(`${lesson.lessonId}: ${message}`);
      await persist();
      // Un intro que falla no aborta al resto: se sigue con las demás
      // clases y esta se salta en la pasada de ensamblaje.
    }
  }

  // Entre las dos pasadas: cualquier bundle que ya se haya cacheado (por
  // ejemplo el de los intros de más arriba) queda obsoleto, porque
  // assets/intros/ recién ahora terminó de llenarse. Invalidarlo fuerza a
  // que el bundle de la fase de clases se regenere con el public/ completo.
  const publicRoots = new Set(planned.map((lesson) => lesson.plan.publicRoot));
  for (const publicRoot of publicRoots) {
    backend.invalidateBundleCache?.(publicRoot);
  }

  /* ========= SEGUNDA PASADA — etapa 11: ensamblaje de clases ========= */
  for (const lesson of planned) {
    const entry = progress.lessons[lesson.lessonId];
    if (introFailed.has(lesson.lessonId)) {
      // El error ya quedó registrado en la primera pasada; no se reintenta
      // el ensamblaje de una clase cuyo intro no se pudo producir.
      continue;
    }

    try {
      // La huella incluye el intro recién renderizado: si el intro cambió,
      // el render de la clase también queda obsoleto.
      const fingerprint = await fingerprintWithIntro(lesson.plan);
      const plan = { ...lesson.plan, sourcesFingerprint: fingerprint };

      if (!force) {
        const reusable = await canSkip(jobId, lesson.lessonId, fingerprint);
        if (reusable) {
          entry.status = "skipped";
          entry.totalFrames = reusable.expectedFrames;
          entry.frame = reusable.expectedFrames;
          await persist();
          continue;
        }
      }

      entry.status = "assembling";
      entry.frame = 0;
      entry.totalFrames = plan.expectedFrames;
      await persist();

      const artifact = await backend.assembleLesson(plan, (p) => {
        entry.frame = p.frame;
        entry.totalFrames = p.totalFrames;
        void persist();
      });

      // El sidecar es lo ÚLTIMO que se escribe: hasta acá, el render no
      // cuenta como completo para nadie.
      await writeRenderSidecar(jobId, {
        lessonId: lesson.lessonId,
        status: "complete",
        backend: artifact.backend,
        file: artifact.path,
        expectedFrames: plan.expectedFrames,
        actualFrames: artifact.frames,
        durationSeconds: artifact.durationSeconds,
        sizeBytes: artifact.sizeBytes,
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        hasAudioStream: true,
        sourcesFingerprint: fingerprint,
        renderedAt: artifact.renderedAt,
      });

      entry.status = "done";
      entry.frame = plan.expectedFrames;
      await persist();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Error desconocido al ensamblar";
      entry.status = "error";
      entry.error = message;
      failures.push(`${lesson.lessonId}: ${message}`);
      await persist();
      // Una clase que falla no aborta al resto: se sigue y al final se
      // reporta todo junto (igual que las demás etapas del pipeline).
    }
  }

  await writeQueue;

  const finishedAt = new Date().toISOString();

  if (failures.length > 0) {
    await updateJobStatus(jobId, "error", {
      stages: {
        intros: { finishedAt },
        assembly: { finishedAt },
      },
      errorMessage: `Falló el ensamblaje de ${failures.length} clase(s): ${failures.join(" | ")}`,
    });
    throw new Error(`Falló el ensamblaje: ${failures.join(" | ")}`);
  }

  await updateJobStatus(jobId, "assembled", {
    stages: {
      intros: { finishedAt },
      assembly: { finishedAt },
    },
  });
}
