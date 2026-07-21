"use client";

/**
 * Pantalla 2: ordenar, titular y confirmar los videos de un job.
 *
 * Al montar hace GET /api/jobs/<jobId> para traer job.json y poblar la
 * lista de entradas (archivo + título) en el orden alfabético en que
 * vienen en job.files. El usuario puede reordenar con ▲/▼ y editar los
 * títulos; al confirmar se hace POST /api/jobs/<jobId>/confirm con
 * {order} y, si sale bien, se navega a la pantalla de "done".
 */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { JobJson, VideoIssue } from "@/lib/types";

/** Una fila editable de la lista: archivo original + título elegido por el usuario. */
interface Entry {
  file: string;
  title: string;
  meta: JobJson["files"][number];
}

/** Traduce cada código de issue a un mensaje corto en español para el badge. */
const ISSUE_LABELS: Record<VideoIssue, string> = {
  not_a_video: "No es video válido",
  zero_duration: "Dura 0s",
  no_audio: "Sin audio",
};

/** Formatea segundos como mm:ss, o h:mm:ss si supera una hora. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

/** Quita la extensión de un nombre de archivo para usarlo como título por defecto. */
function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

export default function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Al montar: traer el job y poblar la lista inicial desde job.files.
  useEffect(() => {
    let cancelled = false;

    async function loadJob() {
      setLoading(true);
      setNotFound(false);
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (res.status === 404) {
          if (!cancelled) {
            setNotFound(true);
            setLoading(false);
          }
          return;
        }
        if (!res.ok) {
          throw new Error("Error al cargar el proyecto");
        }
        const data: { job: JobJson } = await res.json();
        if (!cancelled) {
          setEntries(
            data.job.files.map((meta) => ({
              file: meta.filename,
              title: stripExtension(meta.filename),
              meta,
            }))
          );
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setNotFound(true);
          setLoading(false);
        }
      }
    }

    loadJob();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  /** Intercambia la posición de una entrada con la anterior/siguiente. */
  function moveEntry(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= entries.length) {
      return;
    }
    setEntries((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  /** Actualiza el título editable de una fila. */
  function updateTitle(index: number, title: string) {
    setEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, title } : entry))
    );
  }

  /** Envía el orden y títulos confirmados al backend. */
  async function handleConfirm() {
    setConfirming(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order: entries.map((entry) => ({
            file: entry.file,
            title: entry.title,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error ?? "Error al confirmar el orden");
        setConfirming(false);
        return;
      }
      router.push(`/jobs/${jobId}/done`);
    } catch {
      setErrorMessage("Error de red al confirmar el orden");
      setConfirming(false);
    }
  }

  if (loading) {
    return (
      <main className="container">
        <h1>Cargando proyecto…</h1>
      </main>
    );
  }

  if (notFound) {
    return (
      <main className="container">
        <h1>Proyecto no encontrado</h1>
      </main>
    );
  }

  const totalSeconds = entries.reduce(
    (sum, entry) => sum + entry.meta.durationSeconds,
    0
  );

  return (
    <main className="container">
      <h1>Ordenar y titular videos</h1>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <table className="table">
        <thead>
          <tr>
            <th>Archivo</th>
            <th>Duración</th>
            <th>Resolución</th>
            <th>Título</th>
            <th>Orden</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr key={entry.file}>
              <td>
                {entry.meta.filename}
                {entry.meta.issues.map((issue) => (
                  <span key={issue} className="badge badge-error" style={{ marginLeft: "0.4rem" }}>
                    {ISSUE_LABELS[issue]}
                  </span>
                ))}
              </td>
              <td>{formatDuration(entry.meta.durationSeconds)}</td>
              <td>
                {entry.meta.width}x{entry.meta.height}
              </td>
              <td>
                <input
                  className="input"
                  type="text"
                  value={entry.title}
                  onChange={(e) => updateTitle(index, e.target.value)}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => moveEntry(index, -1)}
                  disabled={index === 0}
                  aria-label="Mover arriba"
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => moveEntry(index, 1)}
                  disabled={index === entries.length - 1}
                  aria-label="Mover abajo"
                >
                  ▼
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        {entries.length} videos — duración total: {formatDuration(totalSeconds)}
      </p>

      <button
        type="button"
        className="btn"
        onClick={handleConfirm}
        disabled={confirming || entries.length === 0}
      >
        {confirming ? "Confirmando…" : "Confirmar orden y títulos"}
      </button>
    </main>
  );
}
