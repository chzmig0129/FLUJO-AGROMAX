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
import { hasCaptionsToAudit, runCaptionsAuditStage } from "./captions-audit-stage";
import { runCaptionsStage } from "./captions-stage";
import { runCutsStage } from "./cuts-stage";
import { runDirectorStage } from "./director-stage";
import { runFramesStage } from "./frames-stage";
import { listRenderedLessonsInModule, runGate3Stage } from "./gate3-stage";
import { hasGate1Composites, runGate1Stage } from "./gate1-stage";
import { runGate2AllStage } from "./gate2-stage";
import {
  cutsDir,
  jobPath,
  readApprovalJson,
  readFramesManifest,
  readJobJson,
  readStructureJson,
  structureJsonPath,
  transcriptsDir,
  updateJobStatus,
} from "./jobs";
import { hasOverlayBriefsPrerequisites, runOverlayBriefsStage } from "./overlay-briefs-stage";
import { hasOverlayGenPrerequisites, runOverlayGenStage } from "./overlay-gen-stage";
import {
  hasOverlaysTimelinePrerequisites,
  runOverlaysTimelineStage,
} from "./overlays-timeline-stage";
import { runPackageStage } from "./package-stage";
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
async function runPrepStages(jobId: string, lessonId?: string): Promise<void> {
  await updateJobStatus(jobId, "preparing", {
    stages: {
      silence: { startedAt: new Date().toISOString() },
      proxies: { startedAt: new Date().toISOString() },
    },
  });
  // Silencio y proxies son por-clip y cacheados (saltan lo ya generado), así
  // que corren sin acotar por lección aunque se pida un lessonId: acotarlos
  // no ahorraría trabajo real y complicaría la firma sin necesidad.
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
  await runCutsStage(jobId, lessonId);
  await updateJobStatus(jobId, "preparing", {
    stages: { cuts: { finishedAt: new Date().toISOString() } },
  });

  // Etapa post-cortes: agrupar las palabras de Whisper en captions y
  // remapearlas al timeline de salida de cada clase (plan/captions/). Sigue
  // en 'preparing': recién se marca 'prepared' cuando esta etapa termina.
  await updateJobStatus(jobId, "preparing", {
    stages: { captions: { startedAt: new Date().toISOString() } },
  });
  await runCaptionsStage(jobId, lessonId);
  await updateJobStatus(jobId, "prepared", {
    stages: { captions: { finishedAt: new Date().toISOString() } },
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
 * Valida (lanzando un error claro si no) que `lessonId` exista entre las
 * lecciones de plan/structure.json del job. Usada por runPrepOnly cuando se
 * pide acotar a una sola clase: a diferencia de runAssemblyStage (que ya
 * falla si la lección no está entre las planificadas), runCutsStage y
 * runCaptionsStage simplemente no producen nada para un lessonId inexistente
 * en vez de lanzar, así que esta validación vive acá.
 */
async function validateLessonExists(
  jobId: string,
  lessonId: string
): Promise<void> {
  const structure = await readStructureJson(jobId);
  if (!structure) {
    throw new Error(
      `No hay plan/structure.json para el job "${jobId}": corre la etapa de plan antes de acotar por lección`
    );
  }
  const exists = structure.modules.some((mod) =>
    mod.lessons.some((lesson) => lesson.id === lessonId)
  );
  if (!exists) {
    throw new Error(
      `La lección "${lessonId}" no existe en plan/structure.json del job "${jobId}"`
    );
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
export function runPrepOnly(
  jobId: string,
  options?: { force?: boolean; lessonId?: string }
): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executePrepOnly(jobId, options).finally(() => {
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/**
 * Ejecuta únicamente las etapas de preparación, validando el status previo
 * del job. Si `options.lessonId` se pasa, valida que la lección exista en
 * plan/structure.json y acota las etapas de cortes y captions a esa única
 * clase (silencio y proxies siguen corriendo sobre todos los clips: son
 * por-clip y cacheados, así que no hay trabajo de más real que ahorrar).
 * `options.force` no cambia el comportamiento de estas etapas (deterministas
 * y siempre re-escriben su salida); se acepta solo por simetría con
 * runAssembleOnly.
 */
async function executePrepOnly(
  jobId: string,
  options?: { force?: boolean; lessonId?: string }
): Promise<void> {
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

    if (options?.lessonId !== undefined) {
      await validateLessonExists(jobId, options.lessonId);
    }

    // Si veníamos de un 'error' anterior con prerequisitos válidos,
    // updateJobStatus limpia errorMessage automáticamente porque el nuevo
    // status ('preparing') no es 'error'.
    await runPrepStages(jobId, options?.lessonId);
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
  options?: { force?: boolean; lessonId?: string }
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

/**
 * Ejecuta el ensamblaje validando el status previo del job. Si
 * `options.lessonId` se pasa, valida que la lección exista en
 * plan/structure.json antes de arrancar (runAssemblyStage también valida,
 * contra el plan de assembly, pero esta validación temprana contra la
 * estructura da un mensaje claro incluso si buildAssemblyPlans fallara antes
 * por otra razón).
 */
async function executeAssembleOnly(
  jobId: string,
  options?: { force?: boolean; lessonId?: string }
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

    if (options?.lessonId !== undefined) {
      await validateLessonExists(jobId, options.lessonId);
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

/* ------------------------------------------------------------------ *
 * runFullPipeline: modo "corre todo solo" (run-all).
 * ------------------------------------------------------------------ */

/**
 * Indica si AUTO_APPROVE está habilitado (cualquier valor "1" o "true",
 * sin distinguir mayúsculas), lo que permite correr `runFullPipeline` sobre
 * un job cuya estructura todavía no fue aprobada por un humano
 * (`plan/approval.json` ausente). Pensado para corridas desatendidas en
 * CI/lotes, nunca como default silencioso.
 */
export function isAutoApproveEnabled(): boolean {
  const raw = (process.env.AUTO_APPROVE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Verifica (tolerante) si `qa/gate1.json` tiene al menos una imagen con
 * `verdict: "REJECTED"`. Se usa solo dentro de `runFullPipeline` para
 * decidir si hace falta invocar al director tras Gate 1 — no hay helper
 * exportado de gate1-stage.ts para esto porque ninguna otra etapa lo
 * necesita.
 */
async function hasGate1Rejections(jobId: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(jobPath(jobId), "qa", "gate1.json"),
      "utf-8"
    );
    const verdict = JSON.parse(raw) as {
      images?: Array<{ verdict?: string }>;
    };
    return (
      Array.isArray(verdict.images) &&
      verdict.images.some((image) => image.verdict === "REJECTED")
    );
  } catch {
    return false;
  }
}

/**
 * Corre el pipeline completo desatendido ("corre todo solo") para un job ya
 * aprobado (o con AUTO_APPROVE): prep -> audit-captions -> overlay-briefs ->
 * overlay-gen (si CDP disponible; se salta sin cortar la cadena si no) ->
 * gate1 (con el director de edición si hay rechazos) -> overlays-timeline ->
 * assemble -> Gate 2 de todas las clases en paralelo (con el director si hay
 * rechazos) -> Gate 3 por módulo -> empaquetado.
 *
 * Reutiliza el mismo registro `running` que el resto del pipeline (dedup):
 * si ya hay una corrida en curso para el jobId (de cualquier etapa), esta
 * llamada devuelve esa misma promesa en vez de arrancar una nueva.
 *
 * Cada eslabón ya existe como stage/endpoint (ver los demás `run*Stage` de
 * este archivo y de `gate1-stage.ts`/`gate2-stage.ts`/`gate3-stage.ts`/
 * `director-stage.ts`/`package-stage.ts`): esto es solo el encadenamiento,
 * llamando directo a las funciones internas (no a los wrappers `run*Only`,
 * que reusarían el mismo registro `running` y quedarían esperando a sí
 * mismos). No hay loops de corrección propios: por diseño (ver NOTES del
 * issue), Gate 2 corre en modo "todas las clases" (`runGate2AllStage`) y
 * cualquier rechazo (de Gate 1 o de Gate 2) se delega en el director de
 * edición (`runDirectorStage`), que ya trae su propio loop de hasta 3
 * vueltas (ver `.claude/commands/director-edicion.md`) — correr un loop acá
 * además sería redundante.
 *
 * Cualquier error real (no un veredicto REJECTED, que es un resultado
 * esperado del QA) detiene la cadena y deja al job en status 'error' con
 * `errorMessage` describiendo en qué eslabón falló.
 */
export function runFullPipeline(jobId: string): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executeFullPipeline(jobId).finally(() => {
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Ejecuta el encadenamiento completo de `runFullPipeline`, con manejo de error. */
async function executeFullPipeline(jobId: string): Promise<void> {
  try {
    const approval = await readApprovalJson(jobId);
    if (!approval && !isAutoApproveEnabled()) {
      throw new Error(
        `No se puede correr el pipeline completo: la estructura del job "${jobId}" no está aprobada (falta plan/approval.json) y AUTO_APPROVE no está habilitado.`
      );
    }

    console.log(`[run-all:${jobId}] prep (silencio/proxies/cortes/captions)`);
    await runPrepStages(jobId);

    if (await hasCaptionsToAudit(jobId)) {
      console.log(`[run-all:${jobId}] audit-captions`);
      await runCaptionsAuditStage(jobId);
    }

    if (await hasOverlayBriefsPrerequisites(jobId)) {
      console.log(`[run-all:${jobId}] overlay-briefs`);
      await runOverlayBriefsStage(jobId);

      if (await hasOverlayGenPrerequisites(jobId)) {
        console.log(`[run-all:${jobId}] overlay-gen`);
        try {
          await runOverlayGenStage(jobId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("CDP")) {
            // CDP no disponible (Chrome sin --remote-debugging-port o sin
            // sesión de chatgpt.com): se salta sin cortar la cadena, per
            // spec ("overlay-gen solo si CDP disponible").
            console.warn(
              `[run-all:${jobId}] overlay-gen omitido (CDP no disponible): ${message}`
            );
          } else {
            throw err;
          }
        }
      }

      if (await hasGate1Composites(jobId)) {
        console.log(`[run-all:${jobId}] gate1`);
        await runGate1Stage(jobId);

        if (await hasGate1Rejections(jobId)) {
          console.log(
            `[run-all:${jobId}] director de edición (rechazos en Gate 1)`
          );
          await runDirectorStage(jobId);
        }
      }
    }

    if (await hasOverlaysTimelinePrerequisites(jobId)) {
      console.log(`[run-all:${jobId}] overlays-timeline`);
      await runOverlaysTimelineStage(jobId);
    }

    console.log(`[run-all:${jobId}] assemble (intros + ensamblaje)`);
    await runAssemblyStage(jobId);

    console.log(`[run-all:${jobId}] gate2-all (todas las clases, en paralelo)`);
    const gate2Results = await runGate2AllStage(jobId);
    const gate2Errors = gate2Results.filter((result) => result.error);
    if (gate2Errors.length > 0) {
      throw new Error(
        `Gate 2 falló para ${gate2Errors.length} clase(s) del job "${jobId}": ${gate2Errors
          .map((result) => `${result.lessonId}: ${result.error}`)
          .join("; ")}`
      );
    }

    const anyGate2Rejected = gate2Results.some(
      (result) => result.verdict === "REJECTED"
    );
    if (anyGate2Rejected) {
      console.log(
        `[run-all:${jobId}] director de edición (rechazos en Gate 2)`
      );
      await runDirectorStage(jobId);
    }

    const structure = await readStructureJson(jobId);
    if (structure) {
      for (const moduleEntry of structure.modules) {
        const renderedLessonIds = await listRenderedLessonsInModule(
          jobId,
          moduleEntry.id
        );
        if (renderedLessonIds.length === 0) {
          continue;
        }
        console.log(`[run-all:${jobId}] gate3 (módulo ${moduleEntry.id})`);
        await runGate3Stage(jobId, moduleEntry.id);
      }
    }

    console.log(`[run-all:${jobId}] package (empaquetado de entrega)`);
    await runPackageStage(jobId);

    console.log(`[run-all:${jobId}] corrida completa terminada`);
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? err.message
        : "Error desconocido en la corrida completa (run-all)";
    console.error(`[run-all:${jobId}] error: ${errorMessage}`);
    const current = await readJobJson(jobId).catch(() => null);
    if (!current || current.status !== "error") {
      await updateJobStatus(jobId, "error", { errorMessage });
    }
  }
}
