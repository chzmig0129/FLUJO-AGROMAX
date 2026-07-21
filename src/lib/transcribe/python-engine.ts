/**
 * Fábrica genérica de motores de transcripción respaldados por un script
 * Python. Cada script (transcribe_mlx.py, transcribe_faster.py, ...) recibe
 * [videoPath, language] como argumentos y debe imprimir a stdout UN único
 * JSON normalizado: {language, duration, segments}. Node no interpreta
 * formatos nativos de Whisper: solo confía en ese contrato de salida.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { TranscribeEngine, TranscriptResult } from "./types";

/** Ruta al intérprete Python del entorno virtual dedicado a transcripción. */
function resolvePythonBin(): string {
  return (
    process.env.PYTHON_BIN ??
    path.join(process.cwd(), ".venv-whisper", "bin", "python")
  );
}

/** Timeout máximo (en minutos) para una transcripción individual. */
function resolveTimeoutMs(): number {
  const minutes = Number(process.env.TRANSCRIBE_TIMEOUT_MIN ?? "60");
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
  return safeMinutes * 60 * 1000;
}

/** Forma cruda que debe tener el JSON emitido por los scripts Python. */
interface RawTranscribeOutput {
  language: string;
  duration: number;
  segments: TranscriptResult["segments"];
}

/**
 * Crea un TranscribeEngine que delega la transcripción real a un script
 * Python vía spawn, respetando el contrato de JSON normalizado descrito
 * arriba.
 */
export function makePythonEngine(
  name: string,
  scriptPath: string,
): TranscribeEngine {
  return {
    name,
    transcribe(videoPath: string, language: string): Promise<TranscriptResult> {
      return new Promise((resolve, reject) => {
        const pythonBin = resolvePythonBin();
        const child = spawn(pythonBin, [scriptPath, videoPath, language]);

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timeoutMs = resolveTimeoutMs();
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(
            new Error(
              `Motor '${name}' excedió el timeout de ${timeoutMs / 60000} min transcribiendo '${path.basename(videoPath)}'`,
            ),
          );
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });

        // El progreso/diagnóstico del motor viaja por stderr; lo dejamos
        // fluir a console.error con un prefijo que identifica el motor.
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr += text;
          console.error(`[transcribe:${name}] ${text.trimEnd()}`);
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(
            new Error(
              `Falló la transcripción de ${path.basename(videoPath)}: no se pudo iniciar '${pythonBin}' (${err.message})`,
            ),
          );
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);

          if (code !== 0) {
            const tail = stderr.trim().split("\n").slice(-10).join("\n");
            reject(
              new Error(
                `Falló la transcripción de ${path.basename(videoPath)}: ${tail || `código de salida ${code}`}`,
              ),
            );
            return;
          }

          let raw: RawTranscribeOutput;
          try {
            raw = JSON.parse(stdout) as RawTranscribeOutput;
          } catch {
            reject(
              new Error(
                `Falló la transcripción de ${path.basename(videoPath)}: el motor '${name}' no devolvió JSON válido`,
              ),
            );
            return;
          }

          resolve({
            language: raw.language,
            durationSeconds: raw.duration,
            segments: raw.segments,
            narration: true,
          });
        });
      });
    },
  };
}
