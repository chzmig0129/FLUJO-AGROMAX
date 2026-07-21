"use client";

/**
 * Pantalla 3: resumen del proyecto ya ingerido.
 * Consulta GET /api/jobs/<id> y muestra un resumen final del job
 * (nombre, id, cantidad de videos, duración total e issues detectados).
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { JobJson, VideoIssue } from "@/lib/types";

/** Texto legible para cada tipo de issue detectado por ffprobe. */
const ISSUE_LABELS: Record<VideoIssue, string> = {
  not_a_video: "No es video válido",
  zero_duration: "Dura 0s",
  no_audio: "Sin audio",
};

/** Formatea segundos como mm:ss, o hh:mm:ss si supera una hora. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${pad(minutes)}:${pad(secs)}`;
}

export default function JobDonePage() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;

  const [job, setJob] = useState<JobJson | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadJob() {
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const data = await res.json();
        if (!cancelled) setJob(data.job as JobJson);
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadJob();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (loading) {
    return (
      <main className="container">
        <p>Cargando proyecto…</p>
      </main>
    );
  }

  if (notFound || !job) {
    return (
      <main className="container">
        <h1>Proyecto no encontrado</h1>
        <Link href="/" className="btn">
          Crear otro proyecto
        </Link>
      </main>
    );
  }

  const totalDurationSeconds = job.files.reduce(
    (sum, file) => sum + file.durationSeconds,
    0
  );
  const filesWithIssues = job.files.filter((file) => file.issues.length > 0);

  return (
    <main className="container">
      <h1>✅ Proyecto listo para la siguiente etapa</h1>

      <div className="row">
        <span>Curso</span>
        <strong>{job.name}</strong>
      </div>

      <div className="row">
        <span>ID del proyecto</span>
        <code>{job.id}</code>
      </div>

      <div className="row">
        <span>Videos</span>
        <strong>{job.files.length}</strong>
      </div>

      <div className="row">
        <span>Duración total</span>
        <strong>{formatDuration(totalDurationSeconds)}</strong>
      </div>

      {filesWithIssues.length > 0 && (
        <>
          <h2>Archivos con problemas ({filesWithIssues.length})</h2>
          {filesWithIssues.map((file) => (
            <div className="row" key={file.filename}>
              <span>{file.filename}</span>
              <span>
                {file.issues.map((issue) => (
                  <span key={issue} className="badge badge-error">
                    {ISSUE_LABELS[issue]}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </>
      )}

      <p>
        <Link href="/" className="btn">
          Crear otro proyecto
        </Link>
      </p>
    </main>
  );
}
