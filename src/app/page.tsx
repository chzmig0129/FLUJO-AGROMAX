'use client';

/**
 * Home del frontend v2: hero de marca, tarjeta de subida del ZIP con barra
 * de progreso REAL (XMLHttpRequest — la Fetch API no expone progreso de
 * subida; el body va RAW con el nombre en el header x-filename para que el
 * backend lo streamee a disco), e historial de proyectos como tarjetas con
 * su estado en español.
 */
import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface JobSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

/** Estado crudo del job → etiqueta corta en español para la tarjeta. */
const STATUS_LABELS: Record<string, string> = {
  ingested: 'Ingerido',
  probing: 'Midiendo',
  probed: 'Medido',
  transcribing: 'Transcribiendo',
  transcribed: 'Transcrito',
  sampling: 'Muestreando',
  sampled: 'Listo para estructurar',
  planning: 'Estructurando',
  planned: 'Estructura lista',
  preparing: 'Preparando corte',
  prepared: 'Corte preparado',
  assembling: 'Ensamblando',
  assembled: 'Clases ensambladas',
  error: 'Error',
};

/** Clase del badge según el estado (verde=avanzado, rojo=error, neutro=resto). */
function statusBadgeClass(status: string): string {
  if (status === 'error') return 'badge badge-error';
  if (status === 'assembled' || status === 'prepared') return 'badge';
  if (status.endsWith('ing')) return 'badge badge-warning';
  return 'badge badge-neutral';
}

// Formatea bytes como GB (2 decimales) si el total supera 1GB, o MB si no.
function formatBytes(bytes: number, useGb: boolean): string {
  if (useGb) {
    return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  }
  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
}

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Progreso de subida (0-100) y fase: 'uploading' mientras sube el ZIP,
  // 'processing' cuando el body llegó al 100% y el backend descomprime y
  // analiza (sin progreso granular: barra indeterminada).
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'processing'>(
    'idle'
  );

  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/jobs')
      .then((res) => res.json())
      .then((data: { jobs?: JobSummary[]; error?: string }) => {
        if (data.jobs) {
          setJobs(data.jobs);
        } else {
          setJobsError(data.error ?? 'No se pudieron cargar los proyectos.');
        }
      })
      .catch(() => setJobsError('No se pudieron cargar los proyectos.'));
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = event.currentTarget;
    const fileInput = form.elements.namedItem('zip') as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) {
      setError('Falta el archivo ZIP');
      return;
    }

    setLoading(true);
    setUploadPct(0);
    setUploadedBytes(0);
    setTotalBytes(file.size);
    setPhase('uploading');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/ingest');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/zip');

    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      setUploadedBytes(ev.loaded);
      setTotalBytes(ev.total);
      const pct = Math.round((ev.loaded / ev.total) * 100);
      setUploadPct(pct);
      if (pct >= 100) {
        setPhase('processing');
      }
    };

    xhr.onload = () => {
      let data: { jobId?: string; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // respuesta no-JSON: se trata como error genérico abajo
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        setError(data.error ?? 'Ocurrió un error inesperado.');
        setLoading(false);
        setPhase('idle');
        return;
      }

      if (!data.jobId) {
        setError('Ocurrió un error inesperado.');
        setLoading(false);
        setPhase('idle');
        return;
      }

      router.push('/jobs/' + data.jobId);
    };

    xhr.onerror = () => {
      setError('No se pudo conectar con el servidor.');
      setLoading(false);
      setPhase('idle');
    };

    xhr.send(file);
  }

  const useGb = totalBytes > 1024 ** 3;

  return (
    <main className="container">
      <section className="home-hero">
        <p className="home-kicker">Pipeline de cursos ganaderos</p>
        <h1 className="home-title">
          Del video crudo al <em>curso entregado</em>, paso a paso.
        </h1>
        <p className="home-sub">
          Subí el ZIP con los videos crudos. El sistema los mide, transcribe y
          propone la estructura del curso; vos aprobás y avanzás etapa por
          etapa hasta la entrega final.
        </p>
      </section>

      <section className="upload-card">
        <h2>Nuevo proyecto</h2>
        <p className="upload-hint">
          Un ZIP con los clips crudos del curso. Los originales nunca se
          modifican.
        </p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label className="dropzone" htmlFor="zip">
            <span className="dropzone-icon" aria-hidden="true">
              ↑
            </span>
            <span className="dropzone-text">
              <strong>{fileName ?? 'Elegí el archivo ZIP'}</strong>
              <span>
                {fileName
                  ? 'Listo para subir'
                  : 'Toca acá para seleccionarlo desde tu equipo'}
              </span>
            </span>
            <input
              id="zip"
              name="zip"
              type="file"
              accept=".zip"
              required
              disabled={loading}
              onChange={(e) =>
                setFileName(e.currentTarget.files?.[0]?.name ?? null)
              }
            />
          </label>

          {phase === 'uploading' && (
            <div className="upload-progress">
              <div className="upload-progress-bar-track">
                <div
                  className="upload-progress-bar-fill"
                  style={{ width: uploadPct + '%' }}
                />
              </div>
              <p className="upload-progress-label">
                Subiendo… {uploadPct}% ({formatBytes(uploadedBytes, useGb)} de{' '}
                {formatBytes(totalBytes, useGb)})
              </p>
            </div>
          )}

          {phase === 'processing' && (
            <div className="upload-progress">
              <div className="upload-progress-bar-track">
                <div className="upload-progress-bar-fill pbar-fill--indeterminate" />
              </div>
              <p className="upload-progress-label">
                <span className="spinner spinner-inline" />
                Descomprimiendo y analizando videos… esto puede tardar varios
                minutos con archivos grandes
              </p>
            </div>
          )}

          <button type="submit" className="btn" disabled={loading}>
            {loading ? 'Procesando…' : 'Crear proyecto'}
          </button>
        </form>
      </section>

      <section className="jobs-list">
        <h2>Historial de proyectos</h2>
        {jobsError && <div className="error-banner">{jobsError}</div>}
        {!jobsError && jobs.length === 0 && (
          <p className="jobs-empty">
            Todavía no hay proyectos. Subí un ZIP para crear el primero.
          </p>
        )}
        {jobs.length > 0 && (
          <ul className="jobs-grid">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link className="job-card" href={'/jobs/' + job.id}>
                  <span className="job-card-name">{job.name}</span>
                  <span className="job-card-meta">
                    <span className={statusBadgeClass(job.status)}>
                      {STATUS_LABELS[job.status] ?? job.status}
                    </span>
                    <span>{new Date(job.createdAt).toLocaleString()}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
