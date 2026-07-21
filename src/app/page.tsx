'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = event.currentTarget;
    const formData = new FormData(form);

    setLoading(true);
    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        // Backend devuelve {error} en español; lo mostramos sin perder el form.
        setError(data.error ?? 'Ocurrió un error inesperado.');
        setLoading(false);
        return;
      }

      router.push('/jobs/' + data.jobId);
    } catch {
      setError('No se pudo conectar con el servidor.');
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>AgroMax Ingesta</h1>
      <p>Subí el ZIP con los videos crudos y el nombre del curso para comenzar.</p>

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
          />
        </div>

        <div className="field">
          <label htmlFor="name">Nombre del curso</label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="input"
            placeholder="Ej: Manejo de suelos"
          />
        </div>

        <button type="submit" className="btn" disabled={loading}>
          {loading
            ? 'Procesando… (descomprimiendo y analizando videos)'
            : 'Procesar'}
        </button>
      </form>
    </main>
  );
}
