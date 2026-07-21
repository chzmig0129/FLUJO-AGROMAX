/**
 * Escritura de las salidas de transcripción a disco.
 *
 * Cada archivo transcrito produce tres formatos hermanos (json/tsv/txt) para
 * distintos consumidores: el JSON conserva el detalle completo (palabras con
 * timestamps), el TSV es apto para hojas de cálculo/edición de subtítulos, y
 * el TXT es texto plano legible por humanos. Además, `writeMasterTxt` junta
 * el resultado de todos los archivos de un job en un único documento de
 * lectura rápida (master.txt).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { TranscriptResult } from "./types";

/** Formatea segundos con 2 decimales fijos, como espera el TSV. */
function formatSeconds(value: number): string {
  return value.toFixed(2);
}

/** Formatea segundos como mm:ss (redondeado hacia abajo), para el master.txt. */
function formatMinutesSeconds(durationSeconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationSeconds));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Escribe los tres formatos de salida (<base>.json, <base>.tsv, <base>.txt)
 * de un TranscriptResult dentro de `transcriptsDir`.
 */
export async function writeTranscriptFiles(
  transcriptsDir: string,
  baseName: string,
  result: TranscriptResult,
): Promise<void> {
  await fs.mkdir(transcriptsDir, { recursive: true });

  const jsonPath = path.join(transcriptsDir, `${baseName}.json`);
  const tsvPath = path.join(transcriptsDir, `${baseName}.tsv`);
  const txtPath = path.join(transcriptsDir, `${baseName}.txt`);

  await fs.writeFile(jsonPath, JSON.stringify(result, null, 2), "utf8");

  const tsvLines = ["start\tend\ttext"];
  for (const segment of result.segments) {
    const text = segment.text.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
    tsvLines.push(
      `${formatSeconds(segment.start)}\t${formatSeconds(segment.end)}\t${text}`,
    );
  }
  await fs.writeFile(tsvPath, `${tsvLines.join("\n")}\n`, "utf8");

  const txtParagraphs = result.segments.map((segment) => segment.text.trim());
  await fs.writeFile(txtPath, `${txtParagraphs.join("\n\n")}\n`, "utf8");
}

/** Entrada del resumen que compone el master.txt de un job. */
export interface MasterTxtEntry {
  filename: string;
  durationSeconds: number;
  narration: boolean;
  text: string;
}

/**
 * Escribe master.txt: un documento único que resume, en orden, todos los
 * archivos transcritos de un job (útil para revisar rápido sin abrir cada
 * archivo individual).
 */
export async function writeMasterTxt(
  transcriptsDir: string,
  entries: MasterTxtEntry[],
): Promise<void> {
  await fs.mkdir(transcriptsDir, { recursive: true });

  const blocks = entries.map((entry) => {
    const header = `=== ${entry.filename} (${formatMinutesSeconds(entry.durationSeconds)}) ===`;
    const lines = [header];

    if (!entry.narration) {
      lines.push("(clip sin narración)");
    }

    lines.push(entry.text.trim());
    // Línea en blanco de separación entre archivos.
    lines.push("");

    return lines.join("\n");
  });

  const masterPath = path.join(transcriptsDir, "master.txt");
  await fs.writeFile(masterPath, `${blocks.join("\n")}\n`, "utf8");
}
