/**
 * Helpers de formato compartidos por el wizard del job (jobs/[jobId]) y sus
 * componentes: duraciones legibles, timestamps mm:ss y tiempo transcurrido
 * por etapa a partir de los StageTiming de job.json.
 */
import type { StageTiming } from "@/lib/types";

/** "1h 3m 12s" a partir de segundos totales. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/** "mm:ss" para captions de miniaturas y rangos de segmentos. */
export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Tiempo transcurrido de una etapa según sus timestamps de job.json.
 * Para etapas en curso (sin finishedAt) usa `nowMs` — el caller lo actualiza
 * con el polling — para que el contador avance en vivo.
 */
export function elapsedOf(
  timing: StageTiming | undefined,
  nowMs: number
): number | null {
  if (!timing?.startedAt) return null;
  const start = new Date(timing.startedAt).getTime();
  const end = timing.finishedAt
    ? new Date(timing.finishedAt).getTime()
    : nowMs;
  if (!Number.isFinite(start) || end < start) return null;
  return (end - start) / 1000;
}

/**
 * Suma el tiempo transcurrido de varias etapas (las ausentes se ignoran).
 * Devuelve null si ninguna arrancó todavía.
 */
export function sumElapsed(
  timings: Array<StageTiming | undefined>,
  nowMs: number
): number | null {
  let total = 0;
  let any = false;
  for (const t of timings) {
    const e = elapsedOf(t, nowMs);
    if (e !== null) {
      total += e;
      any = true;
    }
  }
  return any ? total : null;
}

/** Formatea el resultado de elapsedOf/sumElapsed como chip ("⏱ 3m 12s"). */
export function formatElapsed(seconds: number | null): string | null {
  if (seconds === null) return null;
  return formatDuration(seconds);
}
