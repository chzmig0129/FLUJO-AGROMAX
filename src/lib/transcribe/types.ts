/**
 * Contrato TypeScript del módulo de transcripción (etapa 3 del pipeline).
 *
 * Filosofía: Node.js NUNCA entiende los formatos nativos de los motores de
 * transcripción (mlx-whisper, faster-whisper, etc.). Cada motor corre como
 * un script Python independiente que emite un ÚNICO JSON normalizado a
 * stdout con el contrato definido aquí. Esto permite intercambiar motores
 * (mlx ↔ faster) sin tocar ni una línea del código Node que los consume.
 */

/**
 * Palabra individual con marca de tiempo, tal como la produce Whisper con
 * `word_timestamps=True`.
 */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

/**
 * Segmento de transcripción (oración/frase agrupada por el motor), con el
 * desglose de palabras que lo componen.
 */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

/**
 * Resultado completo y normalizado de transcribir un archivo de video.
 * `narration` no la setea este módulo: la calcula otra capa (detección
 * anti-alucinación) a partir del propio resultado y del nivel de audio; aquí
 * queda en `true` por defecto hasta que esa capa la reevalúe.
 */
export interface TranscriptResult {
  language: string;
  durationSeconds: number;
  segments: TranscriptSegment[];
  narration: boolean;
}

/**
 * Contrato que debe cumplir cualquier motor de transcripción intercambiable
 * (mlx-whisper, faster-whisper, o el que venga después).
 */
export interface TranscribeEngine {
  name: string;
  transcribe(videoPath: string, language: string): Promise<TranscriptResult>;
}
