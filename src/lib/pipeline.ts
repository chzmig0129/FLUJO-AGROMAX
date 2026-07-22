/**
 * pipeline.ts — orquestador del pipeline completo de un job: probe →
 * transcripción → muestreo de frames. Pensado para correr en background (el
 * llamador NO debe hacer await de runPipeline en un request HTTP; es
 * fire-and-forget).
 *
 * Es idempotente: correrlo de nuevo sobre un job ya probado/transcrito/
 * muestreado simplemente vuelve a correr probe, transcribe y frames,
 * sobreescribiendo probe/media.json, transcripts/ y frames/.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { runAssemblyStage } from "./assembly-stage";
import { runCutsStage } from "./cuts-stage";
import { runFramesStage } from "./frames-stage";
import {
  cutsDir,
  readFramesManifest,
  readJobJson,
  structureJsonPath,
  transcriptsDir,
  updateJobStatus,
} from "./jobs";
import { runPlanStage } from "./plan-stage";
import { runProbeStage } from "./probe-stage";
import { runProxyStage } from "./proxy-stage";
import { runSilenceStage } from "./silence-stage";
import { runTranscribeStage } from "./transcribe/index";
import type { JobStatus } from "./types";

/**
 * Registro en memoria de pipelines corriendo, para evitar disparar dos
 * corridas simultáneas del mismo job (por ejemplo si el usuario hace click
 * dos veces en "re-transcribir"). Vive solo mientras el proceso Node está
 * arriba: no persiste entre reinicios, lo cual está bien porque solo se usa
 * para deduplicar requests concurrentes.
 */
const running = new Map<string, Promise<void>>();

/** Indica si ya hay un pipeline corriendo en memoria para ese job. */
export function isPipelineRunning(jobId: string): boolean {
  return running.has(jobId);
}

/**
 * Corre el pipeline completo (probe + transcribe) para un job. Si ya hay
 * una corrida en curso para el mismo jobId, devuelve esa misma promesa en
 * vez de arrancar una nueva (deduplicación).
 */
export function runPipeline(jobId: string): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executePipeline(jobId).finally(() => {
    // Limpiar el registro al terminar (éxito o error) para permitir
    // futuras corridas (por ejemplo re-transcribir).
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Ejecuta las etapas de probe y transcribe en secuencia, con manejo de error. */
async function executePipeline(jobId: string): Promise<void> {
  try {
    // Etapa 2: probe.
    await updateJobStatus(jobId, "probing", {
      stages: { probe: { startedAt: new Date().toISOString() } },
    });
    await runProbeStage(jobId);
    await updateJobStatus(jobId, "probed", {
      stages: { probe: { finishedAt: new Date().toISOString() } },
    });

    // Etapa 3: transcripción.
    await updateJobStatus(jobId, "transcribing", {
      stages: { transcribe: { startedAt: new Date().toISOString() } },
    });
    await runTranscribeStage(jobId);
    await updateJobStatus(jobId, "transcribed", {
      stages: { transcribe: { finishedAt: new Date().toISOString() } },
    });

    // Etapa 3.5: muestreo de frames de referencia.
    await updateJobStatus(jobId, "sampling", {
      stages: { frames: { startedAt: new Date().toISOString() } },
    });
    await runFramesStage(jobId);
    await updateJobStatus(jobId, "sampled", {
      stages: { frames: { finishedAt: new Date().toISOString() } },
    });

    // Etapa 4: filtro editorial y estructura autónoma (agente Claude).
    await updateJobStatus(jobId, "planning", {
      stages: { plan: { startedAt: new Date().toISOString() } },
    });
    await runPlanStage(jobId);
    await updateJobStatus(jobId, "planned", {
      stages: { plan: { finishedAt: new Date().toISOString() } },
    });

    // Etapas 5A/5B/5C: preparación determinista (silencio, proxies, cortes).
    await runPrepStages(jobId);
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Error desconocido en el pipeline";
    await updateJobStatus(jobId, "error", { errorMessage });
  }
}

/**
 * Corre las etapas deterministas de preparación (5A silencio, 5B proxies,
 * 5C cortes) sobre los clips 'leccion' de la estructura del job, encadenando
 * 'preparing' → 'prepared'. No captura errores: el llamador (runPipeline o
 * runPrepOnly) es responsable de marcar el job como 'error' si algo falla
 * acá.
 *
 * 5A (silencio) y 5B (proxies) solo LEEN source/ y structure.json y son
 * independientes entre sí, así que corren en paralelo con Promise.all para
 * ahorrar tiempo de pared (en OVINOS silencio tardó 39 min y proxies ~1h+
 * corriendo en serie). 5C (cortes) depende de la salida de ambas, así que
 * sigue corriendo después, como antes.
 *
 * IMPORTANTE — sin llamadas concurrentes a updateJobStatus: updateJobStatus
 * hace read-modify-write de job.json, así que si silencio y proxies lo
 * llamaran cada uno por su lado DENTRO del Promise.all podrían pisarse el
 * uno al otro (race de lectura-escritura). Por eso los timestamps de
 * startedAt/finishedAt de silence+proxies se registran en UNA sola llamada
 * antes de lanzar el Promise.all y en UNA sola llamada después de que
 * termina, nunca desde adentro de las dos ramas concurrentes. El finishedAt
 * de ambas etapas usa el mismo Date.now() (tomado justo al resolver el
 * Promise.all) aunque en la práctica una termine antes que la otra: es
 * aceptable porque solo se usa para métricas/diagnóstico, no para lógica de
 * negocio.
 *
 * Progress de prep (progress/prep-progress.json): silence-stage.ts NO
 * escribe ese archivo (no importa writePrepProgressJson ni tiene noción de
 * "progress"); solo proxy-stage.ts lo hace. Por lo tanto no hay colisión de
 * escritura concurrente sobre prep-progress.json aunque las dos etapas
 * corran en paralelo: silencio no toca ese archivo en absoluto.
 */
async function runPrepStages(jobId: string): Promise<void> {
  await updateJobStatus(jobId, "preparing", {
    stages: {
      silence: { startedAt: new Date().toISOString() },
      proxies: { startedAt: new Date().toISOString() },
    },
  });
  await Promise.all([runSilenceStage(jobId), runProxyStage(jobId)]);
  const prepFinishedAt = new Date().toISOString();
  await updateJobStatus(jobId, "preparing", {
    stages: {
      silence: { finishedAt: prepFinishedAt },
      proxies: { finishedAt: prepFinishedAt },
    },
  });

  await updateJobStatus(jobId, "preparing", {
    stages: { cuts: { startedAt: new Date().toISOString() } },
  });
  await runCutsStage(jobId);
  await updateJobStatus(jobId, "prepared", {
    stages: { cuts: { finishedAt: new Date().toISOString() } },
  });
}

/**
 * Estados a partir de los cuales tiene sentido (re)correr solo la etapa de
 * frames: el job ya tiene transcripts/ generado (o incluso ya pasó por la
 * etapa de muestreo antes, lo cual es válido para re-muestrear).
 */
const FRAMES_READY_STATUSES: JobStatus[] = [
  "transcribed",
  "sampling",
  "sampled",
];

/**
 * Corre solo la etapa de muestreo de frames para un job ya transcrito
 * (permite re-muestrear sin volver a correr probe/transcribe). Reutiliza el
 * mismo registro `running` que runPipeline para evitar corridas concurrentes
 * del mismo job, sea cual sea la etapa que las disparó.
 */
export function runFramesOnly(jobId: string): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executeFramesOnly(jobId).finally(() => {
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Ejecuta únicamente la etapa de frames, validando el status previo del job. */
async function executeFramesOnly(jobId: string): Promise<void> {
  try {
    const current = await readJobJson(jobId);
    if (!FRAMES_READY_STATUSES.includes(current.status)) {
      throw new Error(
        `No se puede muestrear frames: el job "${jobId}" debe estar transcrito primero (status actual: "${current.status}")`
      );
    }

    await updateJobStatus(jobId, "sampling", {
      stages: { frames: { startedAt: new Date().toISOString() } },
    });
    await runFramesStage(jobId);
    await updateJobStatus(jobId, "sampled", {
      stages: { frames: { finishedAt: new Date().toISOString() } },
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? err.message
        : "Error desconocido en el muestreo de frames";
    await updateJobStatus(jobId, "error", { errorMessage });
  }
}

/**
 * Estados a partir de los cuales tiene sentido (re)correr solo la etapa de
 * plan: el job ya tiene frames/manifest.json generado (o incluso ya pasó
 * por la etapa de plan antes, lo cual es válido para re-planear).
 */
const PLAN_READY_STATUSES: JobStatus[] = ["sampled", "planning", "planned"];

/**
 * Verifica (de forma tolerante, sin lanzar) si un job tiene los prerequisitos
 * reales de la etapa de plan ya generados en disco: transcripts/summary.json
 * (etapa de transcripción) y frames/manifest.json (etapa de muestreo). Se usa
 * para decidir si un job en status 'error' puede reintentar solo el plan sin
 * re-transcribir, distinguiendo un fallo "antes del plan" (faltan
 * prerequisitos) de un fallo "durante el plan" (ej. API key ausente, con
 * prerequisitos ya presentes).
 */
export async function hasPlanPrerequisites(jobId: string): Promise<boolean> {
  const manifest = await readFramesManifest(jobId);
  if (!manifest) {
    return false;
  }
  try {
    await fs.access(path.join(transcriptsDir(jobId), "summary.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Corre solo la etapa de plan (filtro editorial y estructura autónoma) para
 * un job ya muestreado (permite re-planear sin volver a correr probe/
 * transcribe/frames). Reutiliza el mismo registro `running` que runPipeline
 * para evitar corridas concurrentes del mismo job, sea cual sea la etapa que
 * las disparó.
 *
 * También acepta jobs en status 'error' siempre que ya tengan los
 * prerequisitos reales del plan (transcripts/summary.json y
 * frames/manifest.json), lo cual permite reintentar solo el plan (por
 * ejemplo tras configurar ANTHROPIC_API_KEY) sin re-transcribir todo el
 * material. Si el job está en 'error' pero le faltan esos prerequisitos, la
 * falla ocurrió antes del plan y hace falta reintentar el pipeline completo.
 */
export function runPlanOnly(jobId: string): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executePlanOnly(jobId).finally(() => {
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Ejecuta únicamente la etapa de plan, validando el status previo del job. */
async function executePlanOnly(jobId: string): Promise<void> {
  try {
    const current = await readJobJson(jobId);
    const readyByStatus = PLAN_READY_STATUSES.includes(current.status);
    const readyByErrorWithPrereqs =
      current.status === "error" && (await hasPlanPrerequisites(jobId));

    if (!readyByStatus && !readyByErrorWithPrereqs) {
      if (current.status === "error") {
        throw new Error(
          `No se puede reintentar solo el plan: el job "${jobId}" falló antes de completar el muestreo de frames (faltan transcripts/summary.json o frames/manifest.json). Reintenta el pipeline completo.`
        );
      }
      throw new Error(
        `No se puede planear: el job "${jobId}" debe estar muestreado primero (status actual: "${current.status}")`
      );
    }

    // Si veníamos de un 'error' anterior (ej. API key faltante) con
    // prerequisitos válidos, updateJobStatus limpia errorMessage
    // automáticamente porque el nuevo status ('planning') no es 'error'.
    await updateJobStatus(jobId, "planning", {
      stages: { plan: { startedAt: new Date().toISOString() } },
    });
    await runPlanStage(jobId);
    await updateJobStatus(jobId, "planned", {
      stages: { plan: { finishedAt: new Date().toISOString() } },
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? err.message
        : "Error desconocido en la etapa de plan";
    await updateJobStatus(jobId, "error", { errorMessage });
  }
}

/**
 * Estados a partir de los cuales tiene sentido (re)correr solo las etapas de
 * preparación (5A/5B/5C): el job ya tiene plan/structure.json generado (o
 * incluso ya pasó por preparación antes, lo cual es válido para
 * re-prepararlo, por ejemplo tras corregir un `kind` mal marcado).
 */
const PREP_READY_STATUSES: JobStatus[] = ["planned", "preparing", "prepared"];

/**
 * Verifica (de forma tolerante, sin lanzar) si un job tiene el prerequisito
 * real de las etapas de preparación ya generado en disco: plan/structure.json
 * (etapa 4). Se usa para decidir si un job en status 'error' puede
 * reintentar solo la preparación sin re-planear.
 */
async function hasPrepPrerequisites(jobId: string): Promise<boolean> {
  try {
    await fs.access(structureJsonPath(jobId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Corre solo las etapas de preparación (5A silencio, 5B proxies, 5C cortes)
 * para un job ya planeado (permite re-preparar sin volver a correr
 * probe/transcribe/frames/plan). Reutiliza el mismo registro `running` que
 * runPipeline para evitar corridas concurrentes del mismo job, sea cual sea
 * la etapa que las disparó.
 *
 * También acepta jobs en status 'error' siempre que ya tengan el
 * prerequisito real (plan/structure.json), lo cual permite reintentar solo
 * la preparación (por ejemplo tras un fallo puntual de ffmpeg) sin
 * re-planear todo el curso. Si el job está en 'error' pero le falta ese
 * prerequisito, la falla ocurrió antes de la preparación y hace falta
 * reintentar el pipeline completo (o al menos el plan).
 */
export function runPrepOnly(jobId: string): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executePrepOnly(jobId).finally(() => {
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Ejecuta únicamente las etapas de preparación, validando el status previo del job. */
async function executePrepOnly(jobId: string): Promise<void> {
  try {
    const current = await readJobJson(jobId);
    const readyByStatus = PREP_READY_STATUSES.includes(current.status);
    const readyByErrorWithPrereqs =
      current.status === "error" && (await hasPrepPrerequisites(jobId));

    if (!readyByStatus && !readyByErrorWithPrereqs) {
      if (current.status === "error") {
        throw new Error(
          `No se puede reintentar solo la preparación: el job "${jobId}" falló antes de completar el plan (falta plan/structure.json). Reintenta el pipeline completo.`
        );
      }
      throw new Error(
        `No se puede preparar: el job "${jobId}" debe estar planeado primero (status actual: "${current.status}")`
      );
    }

    // Si veníamos de un 'error' anterior con prerequisitos válidos,
    // updateJobStatus limpia errorMessage automáticamente porque el nuevo
    // status ('preparing') no es 'error'.
    await runPrepStages(jobId);
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? err.message
        : "Error desconocido en la preparación";
    await updateJobStatus(jobId, "error", { errorMessage });
  }
}

/**
 * Verifica (de forma tolerante) si un job tiene los prerequisitos reales del
 * ensamblaje ya en disco: plan/cuts/ con al menos un archivo de cortes.
 * structure.json solo no alcanza: sin cortes no hay tramos "keep" que
 * concatenar.
 */
export async function hasAssemblyPrerequisites(
  jobId: string
): Promise<boolean> {
  try {
    const entries = await fs.readdir(cutsDir(jobId));
    return entries.some((entry) => entry.endsWith(".json"));
  } catch {
    return false;
  }
}

/**
 * Corre solo las etapas 9 (intros) y 11 (ensamblaje headless) de un job ya
 * preparado. Reutiliza el mismo registro `running` que el resto del
 * pipeline, para que no haya dos corridas del mismo job en paralelo sin
 * importar qué etapa las disparó.
 *
 * `force` re-renderiza todas las clases aunque ya tengan un render
 * verificado y vigente.
 */
export function runAssembleOnly(
  jobId: string,
  options?: { force?: boolean }
): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executeAssembleOnly(jobId, options).finally(() => {
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Estados desde los que tiene sentido (re)correr el ensamblaje. */
const ASSEMBLY_READY_STATUSES: JobStatus[] = [
  "prepared",
  "assembling",
  "assembled",
];

/** Ejecuta el ensamblaje validando el status previo del job. */
async function executeAssembleOnly(
  jobId: string,
  options?: { force?: boolean }
): Promise<void> {
  try {
    const current = await readJobJson(jobId);
    const readyByStatus = ASSEMBLY_READY_STATUSES.includes(current.status);
    const readyByErrorWithPrereqs =
      current.status === "error" && (await hasAssemblyPrerequisites(jobId));

    if (!readyByStatus && !readyByErrorWithPrereqs) {
      throw new Error(
        `No se puede ensamblar: el job "${jobId}" debe estar preparado primero (status actual: "${current.status}")`
      );
    }

    await runAssemblyStage(jobId, options);
  } catch (err) {
    // runAssemblyStage ya deja el detalle por clase en job.json y en
    // assembly-progress.json; acá solo se garantiza que el job quede en
    // 'error' aunque la falla haya sido antes de arrancar (planner, backend
    // no disponible, etc.).
    const errorMessage =
      err instanceof Error ? err.message : "Error desconocido en el ensamblaje";
    const current = await readJobJson(jobId).catch(() => null);
    if (!current || current.status !== "error") {
      await updateJobStatus(jobId, "error", { errorMessage });
    }
  }
}
