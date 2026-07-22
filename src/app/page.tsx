'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface JobSummary {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

// Formatea bytes como GB (con 2 decimales) si el total supera 1GB, o MB si no
// — para que la barra de progreso muestre una unidad legible según el tamaño
// del ZIP subido.
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
  // Progreso de subida (0-100) y fase: 'uploading' mientras sube el ZIP,
  // 'processing' una vez que el body llegó al 100% y el backend está
  // descomprimiendo/analizando (esa etapa no reporta progreso, así que
  // mostramos un spinner indeterminado).
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'processing'>(
    'idle'
  );

  // Jobs existentes, para navegar a ellos sin tener que saber la URL de
  // antemano. Se cargan una sola vez al montar la página.
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

    // Usamos XMLHttpRequest en lugar de fetch porque fetch no expone
    // progreso de subida (upload.onprogress no tiene equivalente en la
    // Fetch API estándar). El body va RAW (no FormData): el nombre del
    // archivo viaja en el header x-filename para que el backend pueda
    // streamearlo directo a disco sin cargarlo entero en memoria.
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
        // La subida terminó; el servidor ahora descomprime y analiza los
        // videos, lo cual puede tardar varios minutos con archivos grandes.
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
        // Backend devuelve {error} en español; lo mostramos sin perder el form.
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
      <h1>AgroMax Ingesta</h1>
      <p>Subí el ZIP con los videos crudos para comenzar.</p>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="zip">Archivo ZIP</label>
          <input
            id="zip"
            name="zip"
            type="file"
            accept=".zip"
            required
            className="input"
            disabled={loading}
          />
        </div>

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
          <p className="upload-progress-label">
            <span className="spinner spinner-inline" />
            Descomprimiendo y analizando videos… esto puede tardar varios
            minutos con archivos grandes
          </p>
        )}

        <button type="submit" className="btn" disabled={loading}>
          {loading ? 'Procesando…' : 'Procesar'}
        </button>
      </form>

      <section className="jobs-list">
        <h2>Proyectos</h2>
        {jobsError && <div className="error-banner">{jobsError}</div>}
        {!jobsError && jobs.length === 0 && (
          <p>Todavía no hay proyectos. Subí un ZIP para crear el primero.</p>
        )}
        {jobs.length > 0 && (
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                <Link href={'/jobs/' + job.id}>
                  {job.name} — {job.status} —{' '}
                  {new Date(job.createdAt).toLocaleString()}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
