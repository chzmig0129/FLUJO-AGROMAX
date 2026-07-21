"use client";

/**
 * Placeholder temporal de la vista de progreso del job.
 *
 * Esta pantalla será reemplazada por otro issue con la vista real de
 * progreso por etapas y por archivo. Por ahora solo confirma que el job
 * fue ingerido correctamente: trae job.json y muestra un mensaje simple.
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { JobJson } from "@/lib/types";

export default function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();

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
        const data: { job: JobJson } = await res.json();
        if (!cancelled) setJob(data.job);
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
        <h1>Cargando proyecto…</h1>
      </main>
    );
  }

  if (notFound || !job) {
    return (
      <main className="container">
        <h1>Proyecto no encontrado</h1>
      </main>
    );
  }

  return (
    <main className="container">
      <h1>
        Proyecto {job.name} ingerido ({job.files.length} videos) — vista de
        progreso en construcción
      </h1>
    </main>
  );
}
