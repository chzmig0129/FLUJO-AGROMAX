/**
 * overlay-gen-stage.ts — etapa 8a del pipeline: generación de las
 * ilustraciones (overlays) a partir de los briefs de la etapa 7
 * (`plan/overlays/<lessonId>.json`), portando la mecánica de scraper CDP de
 * `/Users/chavez/Documents/AGROMAX/EDITOR/overlays/gen_ilustraciones.py` y
 * el post-proceso (flood-fill + trim + sombra, sin rembg) de
 * `procesar_ilustraciones.py` del mismo directorio.
 *
 * Encadena, en secuencia, dos scripts Python vía `spawn` (mismo patrón que
 * `transcribe/python-engine.ts`):
 *
 *   1. scripts/gen_overlays.py <jobDir>       — genera assets/overlays/raw/<key>.jpg
 *   2. scripts/procesar_overlays.py <jobDir>  — genera assets/overlays/final/<key>.png
 *                                                y qa/gate1-chk/<key>.jpg
 *
 * Cada script imprime a stdout UN único JSON de resumen al terminar
 * (`{..., fallidas: [{key, error}]}`); todo el log/progreso viaja por
 * stderr (se reenvía a console.error con prefijo, igual que
 * python-engine.ts).
 *
 * gen_overlays.py depende de un Chrome real corriendo con
 * --remote-debugging-port=9222 y una sesión de chatgpt.com ya iniciada —
 * solo existe en la Mac del usuario. Si no puede conectar, imprime a
 * stderr una línea que arranca con "CDP_UNAVAILABLE:" y sale con código 2;
 * acá se detecta esa condición y se relanza un error con un mensaje claro
 * en español en vez del stacktrace crudo de playwright.
 *
 * No toca jobs.ts, types.ts, remotion/ ni assembly/: solo lee
 * `plan/overlays/*.json` (etapa 7, intocable) y escribe dentro de
 * `assets/overlays/` y `qa/gate1-chk/` del propio job.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { jobPath } from "./jobs";

/** Ruta al intérprete Python del entorno virtual dedicado a overlays. */
function resolveOverlaysPythonBin(): string {
  return process.env.OVERLAYS_PYTHON_BIN ?? "python3";
}

/** Timeout máximo (en minutos) por cada script de la etapa. */
function resolveOverlayGenTimeoutMs(): number {
  const minutes = Number(process.env.OVERLAY_GEN_TIMEOUT_MIN ?? "40");
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 40;
  return safeMinutes * 60 * 1000;
}

/** Ruta absoluta al subdirectorio plan/overlays/ de un job. */
function overlaysDirPath(jobId: string): string {
  return path.join(jobPath(jobId), "plan", "overlays");
}

/** Resumen JSON estándar que imprimen ambos scripts (gen_overlays.py y procesar_overlays.py). */
interface OverlayScriptSummary {
  fallidas: Array<{ key: string; error: string }>;
  [key: string]: unknown;
}

/**
 * Verifica (tolerante) si el job tiene al menos un brief en total, sumando
 * los `briefs[]` de TODOS los `plan/overlays/<lessonId>.json` (la etapa 7
 * escribe un archivo por lección, incluidas las que quedaron con 0
 * briefs). 0 briefs por lección es válido; 0 briefs en TODO el job no
 * amerita correr la generación de imágenes.
 */
export async function hasOverlayGenPrerequisites(jobId: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(overlaysDirPath(jobId));
  } catch {
    return false;
  }

  const jsonFiles = entries.filter((entry) => entry.endsWith(".json"));
  if (jsonFiles.length === 0) return false;

  for (const file of jsonFiles) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(overlaysDirPath(jobId), file), "utf-8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { briefs?: unknown[] };
      if (Array.isArray(parsed.briefs) && parsed.briefs.length > 0) {
        return true;
      }
    } catch {
      // Archivo inválido: no cuenta, se sigue con el siguiente.
    }
  }

  return false;
}

/**
 * Corre un script Python de la etapa (gen_overlays.py o
 * procesar_overlays.py) vía spawn, con `<jobDir>` como único argumento.
 * Reenvía stderr a console.error línea por línea (progreso), y al cerrar
 * intenta parsear stdout como el JSON de resumen del script.
 *
 * Si el proceso sale con código 2 y stderr contiene el marcador
 * "CDP_UNAVAILABLE:", rechaza con un mensaje claro sobre cómo habilitar el
 * CDP en vez de propagar el stacktrace crudo de playwright.
 */
function runOverlayScript(
  scriptPath: string,
  jobDir: string,
  label: string,
): Promise<OverlayScriptSummary> {
  return new Promise((resolve, reject) => {
    const pythonBin = resolveOverlaysPythonBin();
    const child = spawn(pythonBin, [scriptPath, jobDir], { cwd: process.cwd() });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeoutMs = resolveOverlayGenTimeoutMs();
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `La etapa de overlays (${label}) excedió el timeout de ${timeoutMs / 60000} min para el job '${path.basename(jobDir)}'`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      console.error(`[overlay-gen:${label}] ${text.trimEnd()}`);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Falló la etapa de overlays (${label}): no se pudo iniciar '${pythonBin}' (${err.message})`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (stderr.includes("CDP_UNAVAILABLE:")) {
        reject(
          new Error(
            "No se pudo conectar a ChatGPT vía CDP para generar los overlays: abre Chrome con --remote-debugging-port=9222 y sesión de chatgpt.com iniciada — solo disponible en el Mac.",
          ),
        );
        return;
      }

      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-10).join("\n");
        reject(
          new Error(
            `Falló la etapa de overlays (${label}): ${tail || `código de salida ${code}`}`,
          ),
        );
        return;
      }

      let summary: OverlayScriptSummary;
      try {
        summary = JSON.parse(stdout) as OverlayScriptSummary;
      } catch {
        reject(
          new Error(
            `Falló la etapa de overlays (${label}): no devolvió JSON válido por stdout`,
          ),
        );
        return;
      }

      resolve(summary);
    });
  });
}

/** Resultado agregado de las dos mitades de la etapa 8a, para quien quiera inspeccionarlo. */
export interface OverlayGenResult {
  gen: OverlayScriptSummary;
  procesar: OverlayScriptSummary;
}

/**
 * Corre la etapa 8a completa para un job: primero gen_overlays.py (genera
 * las imágenes crudas vía ChatGPT/CDP), luego procesar_overlays.py
 * (flood-fill + trim + sombra + composite de chequeo del Gate 1) — en ese
 * orden, porque el segundo script depende de la salida del primero.
 *
 * Valida antes que el job tenga al menos un brief en total (si no, lanza
 * de inmediato sin invocar Python).
 */
export async function runOverlayGenStage(jobId: string): Promise<OverlayGenResult> {
  const ok = await hasOverlayGenPrerequisites(jobId);
  if (!ok) {
    throw new Error(
      `No se pueden generar overlays: el job '${jobId}' no tiene ningún brief en 'plan/overlays/*.json' (falta correr la etapa de briefs de overlays primero, o el curso no tiene overlays que generar).`,
    );
  }

  const jobDir = jobPath(jobId);

  const gen = await runOverlayScript(
    path.join(process.cwd(), "scripts", "gen_overlays.py"),
    jobDir,
    "gen",
  );

  const procesar = await runOverlayScript(
    path.join(process.cwd(), "scripts", "procesar_overlays.py"),
    jobDir,
    "procesar",
  );

  return { gen, procesar };
}
