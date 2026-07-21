"use client";

/**
 * Vista de progreso de un job: pollea GET /api/jobs/<id> cada 2s mientras el
 * pipeline no haya terminado (status !== 'transcribed' && !== 'error'),
 * muestra un stepper de etapas (ingesta → probe → transcripción), el detalle
 * por archivo durante la transcripción, y al terminar el resumen final con
 * master.txt y el botón de re-transcribir.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { JobJson, MediaInfo, ProgressJson } from "@/lib/types";

/** Forma del summary.json que arma la etapa de transcripción. */
interface SummaryFile {
  filename: string;
  narration: boolean;
  durationSeconds: number;
  status: "done" | "error";
}

interface SummaryJson {
  files: SummaryFile[];
}

interface JobApiResponse {
  job: JobJson;
  media: MediaInfo[] | null;
  progress: ProgressJson | null;
  summary: SummaryJson | null;
}

const POLL_INTERVAL_MS = 2000;

/** Etapas mostradas en el stepper, en orden. */
type StepKey = "ingest" | "probe" | "transcribe";

/**
 * Deriva el estado de cada etapa del stepper ('done' | 'active' | 'pending' |
 * 'error') a partir de job.status.
 */
function stepStatus(
  step: StepKey,
  status: JobJson["status"]
): "done" | "active" | "pending" | "error" {
  if (status === "error") {
    // La etapa activa al momento del error es la que falló; las siguientes
    // quedan pendientes. Sin más info que job.status, marcamos como error
    // solo la etapa "actual" según el orden esperado y dejamos las previas
    // como completas.
    const order: StepKey[] = ["ingest", "probe", "transcribe"];
    const failedIndex = order.findIndex((s) => s === step);
    // No sabemos con certeza en qué etapa fue el error; usamos una heurística
    // simple: si aún no hay media.json asumimos que falló en probe, si ya
    // hay media.json asumimos que falló en transcribe. Esto se resuelve en
    // el render con la prop 'media' disponible, así que aquí devolvemos
    // 'pending' salvo 'ingest' (siempre completada si el job existe).
    return failedIndex === 0 ? "done" : "pending";
  }

  if (step === "ingest") {
    return "done";
  }

  if (step === "probe") {
    if (status === "probing") return "active";
    if (status === "ingested") return "pending";
    return "done"; // probed, transcribing, transcribed
  }

  // step === 'transcribe'
  if (status === "transcribing") return "active";
  if (status === "transcribed") return "done";
  return "pending"; // ingested, probing, probed
}

const STEP_LABELS: Record<StepKey, string> = {
  ingest: "Ingesta",
  probe: "Midiendo",
  transcribe: "Transcribiendo",
};

function formatDuration(totalSeconds: number): string {
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

export default function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();

  const [data, setData] = useState<JobApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [retranscribing, setRetranscribing] = useState(false);
  const [retranscribeError, setRetranscribeError] = useState<string | null>(
    null
  );
  const [showMaster, setShowMaster] = useState(false);
  const [masterText, setMasterText] = useState<string | null>(null);
  const [masterLoading, setMasterLoading] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) {
        setNotFound(true);
        return null;
      }
      const body: JobApiResponse = await res.json();
      setData(body);
      setNotFound(false);
      return body;
    } catch {
      setNotFound(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  /**
   * Arranca (o reanuda) el ciclo de polling: consulta el job y, si aún no
   * terminó (status distinto de 'transcribed'/'error'), programa la
   * siguiente consulta 2s después. Se usa tanto al montar como después de
   * disparar una re-transcripción.
   */
  const startPolling = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    let cancelled = false;

    async function tick() {
      const body = await loadJob();
      if (cancelled) return;

      const status = body?.job.status;
      const finished = status === "transcribed" || status === "error";
      if (!finished) {
        timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    tick();

    return () => {
      cancelled = true;
    };
  }, [loadJob]);

  useEffect(() => {
    const stop = startPolling();
    return () => {
      stop?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Solo se re-ejecuta si cambia jobId (loadJob depende de jobId).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const handleRetranscribe = useCallback(async () => {
    setRetranscribeError(null);
    setRetranscribing(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/transcribe`, {
        method: "POST",
      });
      if (res.status === 409) {
        setRetranscribeError("El proyecto ya se está procesando.");
        return;
      }
      if (!res.ok) {
        setRetranscribeError("No se pudo iniciar la re-transcripción.");
        return;
      }
      // Reanuda el polling de inmediato para reflejar el nuevo status.
      startPolling();
    } catch {
      setRetranscribeError("No se pudo iniciar la re-transcripción.");
    } finally {
      setRetranscribing(false);
    }
  }, [jobId, startPolling]);

  const handleToggleMaster = useCallback(async () => {
    const next = !showMaster;
    setShowMaster(next);
    if (next && masterText === null && !masterLoading) {
      setMasterLoading(true);
      setMasterError(null);
      try {
        const res = await fetch(`/api/jobs/${jobId}/master`);
        if (!res.ok) {
          setMasterError("No se pudo cargar la transcripción completa.");
          return;
        }
        const text = await res.text();
        setMasterText(text);
      } catch {
        setMasterError("No se pudo cargar la transcripción completa.");
      } finally {
        setMasterLoading(false);
      }
    }
  }, [jobId, masterLoading, masterText, showMaster]);

  if (loading) {
    return (
      <main className="container">
        <h1>Cargando proyecto…</h1>
      </main>
    );
  }

  if (notFound || !data) {
    return (
      <main className="container">
        <h1>Proyecto no encontrado</h1>
      </main>
    );
  }

  const { job, media, progress, summary } = data;
  const isError = job.status === "error";
  const isDone = job.status === "transcribed";

  const progressFiles = progress?.files ?? {};
  const totalFiles = job.files.length;
  const doneFiles = Object.values(progressFiles).filter(
    (f) => f.status === "done" || f.status === "error"
  ).length;

  const totalDuration = media
    ? media.reduce((acc, m) => acc + m.durationSeconds, 0)
    : job.files.reduce((acc, f) => acc + f.durationSeconds, 0);

  const brollFiles = summary?.files.filter((f) => !f.narration) ?? [];

  return (
    <main className="container">
      <h1>Proyecto {job.name}</h1>

      {isError && (
        <div className="error-banner">
          <strong>Ocurrió un error en el pipeline.</strong>
          <p>{job.errorMessage ?? "Error desconocido."}</p>
          <button
            className="btn"
            type="button"
            onClick={handleRetranscribe}
            disabled={retranscribing}
          >
            {retranscribing ? "Reintentando…" : "Reintentar"}
          </button>
          {retranscribeError && (
            <p className="stepper-error-msg">{retranscribeError}</p>
          )}
        </div>
      )}

      <ol className="stepper">
        {(["ingest", "probe", "transcribe"] as StepKey[]).map((step) => {
          const status = stepStatus(step, job.status);
          return (
            <li key={step} className={`stepper-step stepper-step--${status}`}>
              <span className="stepper-icon" aria-hidden="true">
                {status === "done" && "✓"}
                {status === "active" && <span className="spinner" />}
                {status === "pending" && "•"}
              </span>
              <span className="stepper-label">
                {STEP_LABELS[step]}
                {step === "transcribe" &&
                  job.status === "transcribing" &&
                  ` (${doneFiles}/${totalFiles})`}
              </span>
            </li>
          );
        })}
      </ol>

      {job.status === "transcribing" && (
        <section>
          <h2>
            Transcribiendo archivos ({doneFiles}/{totalFiles})
          </h2>
          <div>
            {job.files.map((f) => {
              const fileProgress = progressFiles[f.filename];
              const status = fileProgress?.status ?? "pending";
              return (
                <div className="row" key={f.filename}>
                  <span>{f.filename}</span>
                  <span>
                    {status === "pending" && "pendiente"}
                    {status === "running" && (
                      <>
                        <span className="spinner spinner-inline" /> ⏳
                        transcribiendo
                      </>
                    )}
                    {status === "done" && "✓"}
                    {status === "error" && (
                      <span className="badge badge-error">
                        error{fileProgress?.error ? `: ${fileProgress.error}` : ""}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {isDone && (
        <section>
          <h2>Resumen</h2>
          <p>
            {job.files.length} videos — duración total{" "}
            {formatDuration(totalDuration)}
          </p>

          {brollFiles.length > 0 && (
            <div>
              {brollFiles.map((f) => (
                <div className="row" key={f.filename}>
                  <span>{f.filename}</span>
                  <span>🎬 B-roll / sin narración</span>
                </div>
              ))}
            </div>
          )}

          <div className="stepper-actions">
            <button
              className="btn"
              type="button"
              onClick={handleRetranscribe}
              disabled={retranscribing}
            >
              {retranscribing ? "Re-transcribiendo…" : "Re-transcribir"}
            </button>
          </div>
          {retranscribeError && (
            <p className="stepper-error-msg">{retranscribeError}</p>
          )}

          <div>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleToggleMaster}
            >
              {showMaster
                ? "Ocultar transcripción completa"
                : "Ver transcripción completa"}
            </button>
            {showMaster && (
              <div>
                {masterLoading && <p>Cargando master.txt…</p>}
                {masterError && <p className="stepper-error-msg">{masterError}</p>}
                {masterText !== null && !masterLoading && (
                  <pre className="master-pre">{masterText}</pre>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
