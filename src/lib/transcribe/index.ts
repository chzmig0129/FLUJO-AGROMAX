/**
 * transcribe/index.ts — orquestador de la etapa 3 del pipeline (transcripción).
 *
 * Recorre los archivos de jobs/<id>/source/ (en el orden de probe/media.json),
 * transcribe cada uno con el motor intercambiable configurado, detecta si el
 * clip tiene narración real (anti-alucinación) y escribe las salidas en
 * jobs/<id>/transcripts/. El progreso por archivo se persiste en
 * jobs/<id>/progress/progress.json en cada transición de estado, para que la
 * UI pueda pollear ese archivo mientras el job corre.
 *
 * Nunca lee ni escribe nada dentro de source/ salvo la lectura del propio
 * archivo de video para transcribirlo: source/ es inmutable (ver jobs.ts).
 * Re-correr esta etapa es idempotente: sobreescribe transcripts/ y
 * progress.json desde cero.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import {
  readMediaJson,
  sourcePath,
  transcriptsDir,
  writeProgressJson,
} from "../jobs";
import type { FileTranscriptStatus, ProgressJson } from "../types";
import { getEngine } from "./engine";
import { measureAudioEnergy, detectNarration } from "./narration";
import { writeTranscriptFiles, writeMasterTxt, type MasterTxtEntry } from "./writer";
import type { TranscriptResult } from "./types";

/** Cantidad de transcripciones concurrentes (mini-pool sin dependencias nuevas). */
function resolveConcurrency(): number {
  const raw = Number(process.env.TRANSCRIBE_CONCURRENCY ?? "2");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

/** Idioma pasado al motor de transcripción. */
function resolveLanguage(): string {
  return process.env.TRANSCRIBE_LANG ?? "es";
}

/** Quita la extensión de un nombre de archivo para usarlo como baseName de salida. */
function stripExtension(filename: string): string {
  const ext = path.extname(filename);
  return ext ? filename.slice(0, -ext.length) : filename;
}

/** Entrada interna: un archivo a transcribir con su duración conocida (de media.json). */
interface FileToTranscribe {
  filename: string;
  durationSeconds: number;
}

/**
 * Mini-pool de concurrencia: procesa `items` con a lo sumo `concurrency`
 * tareas en simultáneo, sin depender de librerías externas. Cada tarea corre
 * `worker` y los errores individuales NO abortan el resto (deben manejarse
 * dentro de `worker`).
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const currentIndex = nextIndex;
    nextIndex += 1;
    if (currentIndex >= items.length) return;
    await worker(items[currentIndex]);
    await runNext();
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () =>
    runNext(),
  );
  await Promise.all(workers);
}

/**
 * Corre la etapa de transcripción completa de un job: lee media.json y
 * source/, transcribe cada archivo con el motor configurado, detecta
 * narración, escribe transcripts/ y actualiza progress.json en cada paso.
 * `onFileUpdate` es un callback opcional (además de la persistencia en
 * disco) para que quien invoque la etapa reaccione en memoria si lo desea.
 */
export async function runTranscribeStage(
  jobId: string,
  onFileUpdate?: (filename: string, status: FileTranscriptStatus) => void,
): Promise<void> {
  const media = await readMediaJson(jobId);

  // Si todavía no corrió la etapa de probe, caemos de vuelta a listar
  // source/ directamente (sin duración conocida) para no bloquear la etapa.
  const files: FileToTranscribe[] = media
    ? media.map((m) => ({ filename: m.filename, durationSeconds: m.durationSeconds }))
    : (await fs.readdir(sourcePath(jobId)))
        .filter((name) => !name.startsWith("."))
        .map((filename) => ({ filename, durationSeconds: 0 }));

  const outDir = transcriptsDir(jobId);

  // Progreso inicial: todos 'pending'.
  const progress: ProgressJson = {
    files: Object.fromEntries(
      files.map((f) => [f.filename, { status: "pending" as FileTranscriptStatus }]),
    ),
  };
  await writeProgressJson(jobId, progress);

  const engine = getEngine();
  const language = resolveLanguage();
  const concurrency = resolveConcurrency();

  // Resultados por archivo, en el orden final requerido para master.txt/summary.json.
  const results = new Map<
    string,
    { status: FileTranscriptStatus; narration: boolean; durationSeconds: number; text: string }
  >();

  async function setStatus(
    filename: string,
    status: FileTranscriptStatus,
    error?: string,
  ): Promise<void> {
    progress.files[filename] = error ? { status, error } : { status };
    await writeProgressJson(jobId, progress);
    onFileUpdate?.(filename, status);
  }

  async function transcribeOne(file: FileToTranscribe): Promise<void> {
    const { filename } = file;
    const videoPath = path.join(sourcePath(jobId), filename);

    await setStatus(filename, "running");

    try {
      const result: TranscriptResult = await engine.transcribe(videoPath, language);
      const rmsDb = await measureAudioEnergy(videoPath);
      result.narration = detectNarration(result, rmsDb);

      const baseName = stripExtension(filename);
      await writeTranscriptFiles(outDir, baseName, result);

      const text = result.segments.map((s) => s.text.trim()).join("\n\n");
      results.set(filename, {
        status: "done",
        narration: result.narration,
        durationSeconds: result.durationSeconds || file.durationSeconds,
        text,
      });

      await setStatus(filename, "done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.set(filename, {
        status: "error",
        narration: false,
        durationSeconds: file.durationSeconds,
        text: "",
      });
      // Un error individual no aborta el resto de los archivos.
      await setStatus(filename, "error", message);
    }
  }

  await runPool(files, concurrency, transcribeOne);

  // master.txt en el orden de media.json; los archivos con error se anotan
  // en vez de omitirse, para que quede constancia clara en el resumen.
  const masterEntries: MasterTxtEntry[] = files.map((f) => {
    const r = results.get(f.filename);
    if (!r || r.status === "error") {
      return {
        filename: f.filename,
        durationSeconds: f.durationSeconds,
        narration: false,
        text: "(error de transcripción)",
      };
    }
    return {
      filename: f.filename,
      durationSeconds: r.durationSeconds,
      narration: r.narration,
      text: r.text,
    };
  });
  await writeMasterTxt(outDir, masterEntries);

  // Resumen de la etapa para consumo de la UI/APIs.
  const summary = {
    files: files.map((f) => {
      const r = results.get(f.filename);
      return {
        filename: f.filename,
        narration: r?.narration ?? false,
        durationSeconds: r?.durationSeconds ?? f.durationSeconds,
        status: r?.status ?? "error",
      };
    }),
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
}
