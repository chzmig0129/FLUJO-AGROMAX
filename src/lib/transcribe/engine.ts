/**
 * Selector de motor de transcripción. El motor se elige vía la variable de
 * entorno TRANSCRIBE_ENGINE ('mlx' por defecto, u opcionalmente 'faster'),
 * lo que permite intercambiar el backend de Whisper sin tocar el resto del
 * pipeline: ambos motores emiten el mismo JSON normalizado (ver
 * python-engine.ts y types.ts).
 */

import path from "node:path";
import { makePythonEngine } from "./python-engine";
import type { TranscribeEngine } from "./types";

/**
 * Devuelve el TranscribeEngine configurado por TRANSCRIBE_ENGINE.
 * - 'mlx' (default): mlx-whisper, óptimo para Apple Silicon.
 * - 'faster': faster-whisper, alternativa multiplataforma.
 */
export function getEngine(): TranscribeEngine {
  const engineName = process.env.TRANSCRIBE_ENGINE ?? "mlx";

  switch (engineName) {
    case "mlx":
      return makePythonEngine(
        "mlx",
        path.join(process.cwd(), "scripts", "transcribe_mlx.py"),
      );
    case "faster":
      return makePythonEngine(
        "faster",
        path.join(process.cwd(), "scripts", "transcribe_faster.py"),
      );
    default:
      throw new Error(
        `Motor de transcripción desconocido: ${engineName} (usa mlx o faster)`,
      );
  }
}
