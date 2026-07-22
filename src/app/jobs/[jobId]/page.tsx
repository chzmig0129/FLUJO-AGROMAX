"use client";

/**
 * Vista de progreso de un job: pollea GET /api/jobs/<id> cada 2s mientras el
 * pipeline no haya terminado, muestra un stepper de etapas (ingesta → probe →
 * transcripción → muestreo de frames → estructurando/agente), el detalle por
 * archivo durante la transcripción, y al terminar el resumen final con
 * master.txt, la galería de frames por clip y los botones de re-transcribir /
 * re-muestrear.
 *
 * Compat con jobs viejos (creados antes de la etapa de muestreo): si el
 * status queda en 'transcribed' sin que exista manifest de frames, se trata
 * como un estado estable (no un "cargando" perpetuo) y se ofrece el botón
 * "Muestrear frames" para disparar la etapa manualmente. Del mismo modo, un
 * job en 'sampled' sin structure.json todavía (jobs que no llegaron a correr
 * la etapa de plan) es un estado estable: se ofrece el botón "Generar
 * estructura (agente)" para disparar POST /api/jobs/<id>/plan.
 *
 * Cuando ya existe structure.json se muestra la sección de AUDITORÍA
 * solo-lectura de la etapa 4 (filtro editorial + estructura autónoma del
 * agente): árbol de estructura del curso, tarjetas por clip con el veredicto
 * del agente y sus frames, apartados (descartes / otro curso) y
 * decisiones.md. No hay controles de aprobar/bloquear: la etapa corre sin
 * humano en el loop, esto es solo para auditar después.
 *
 * Si el job cae en 'error' pero ya tiene frames/manifest.json (los
 * prerequisitos reales del plan), se ofrece además "Reintentar plan (sin
 * re-transcribir)" — útil cuando la falla fue solo de la etapa de plan (ej.
 * ANTHROPIC_API_KEY ausente). El botón "Reintentar pipeline completo" sigue
 * disponible para fallas anteriores (probe/transcribe/frames).
 *
 * Un job en 'planned' es, igual que 'sampled' antes de él, un estado
 * ESTABLE de reposo: se ofrece el botón "Preparar corte (silencio + proxies
 * + cortes)" para disparar POST /api/jobs/<id>/prep (etapas 5A/5B/5C). Una
 * vez que 'preparing' arranca, el 6º paso del stepper muestra un
 * sub-progreso de proxies (X/N) leído de prepProgress.files, y al llegar a
 * 'prepared' se muestra la sección de resultados: tabla de silencio/shrink
 * por clip y, por lección, cantidad de cortes y duración cruda vs.
 * proyectada, con el detalle de cada corte expandible. El botón se vuelve
 * "Re-preparar corte" una vez que ya hay resultados. Si el job cae en
 * 'error' pero ya tiene plan/structure.json (el prerequisito real de la
 * preparación), se ofrece "Reintentar preparación" para reintentar solo
 * 5A/5B/5C sin re-planear.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type {
  AssemblyProgressJson,
  AuditJson,
  CutsFile,
  FramesManifest,
  JobJson,
  MediaInfo,
  ProgressJson,
  RenderSidecar,
  SilenceJson,
  StructureJson,
  Verdict,
} from "@/lib/types";

/**
 * Forma de un problema detectado por el Gate 2 (QA visual post-ensamblaje)
 * en uno de los frames de la clase renderizada.
 */
interface Gate2Problema {
  frame: number;
  tipo: string;
  detalle: string;
  severidad: string;
}

/** Forma del veredicto del Gate 2 leído de qa/gate2/<lessonId>.json. */
interface Gate2Verdict {
  lessonId: string;
  auditedAt: string;
  verdict: "APPROVED" | "REJECTED";
  frames_revisados: number;
  problemas: Gate2Problema[];
}

/** Un hallazgo detectado por el Gate 3 (revisión de módulo completo). */
interface Gate3Hallazgo {
  tipo: string;
  detalle: string;
  severidad: string;
  lessonId?: string;
}

/** Forma del veredicto del Gate 3 leído de qa/gate3/<moduleId>.json. */
interface Gate3Verdict {
  moduleId: string;
  auditedAt: string;
  verdict: "APPROVED" | "REJECTED";
  hallazgos: Gate3Hallazgo[];
}

/** Una lección empaquetada, leída de deliver/manifest.json. */
interface PackageManifestLesson {
  lessonId: string;
  moduleId: string;
  fileName: string;
  notasPath: string;
}

/** Forma de deliver/manifest.json (empaquetado del curso para entrega). */
interface PackageManifest {
  packagedAt: string;
  courseDir: string;
  lessons: PackageManifestLesson[];
}

/** Un brief de overlay generado para una clase. */
interface OverlayBrief {
  key: string;
  fact: string;
  at_seconds: number;
  clip: string;
  prompt: string;
  aspect: string;
}

/** Forma de plan/overlays/<lessonId>.json (briefs de overlays de una clase). */
interface OverlayBriefsFile {
  lessonId: string;
  generatedAt: string;
  briefs: OverlayBrief[];
}

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
  manifest: FramesManifest | null;
  structure: StructureJson | null;
  /** Gate humano de la etapa 6: null mientras la estructura no fue aprobada. */
  approval: { approvedAt: string } | null;
  audit: AuditJson | null;
  verdicts: Verdict[] | null;
  decisiones: string | null;
  silence: SilenceJson | null;
  cuts: CutsFile[] | null;
  prepProgress: ProgressJson | null;
  assemblyProgress: AssemblyProgressJson | null;
  /** Sidecars de los renders YA VERIFICADOS como completos (o null si no hay). */
  renders: RenderSidecar[] | null;
  /** Veredicto del Gate 2 (QA visual) por lección, o null si aún no fue auditada. */
  gate2Verdicts?: Record<string, Gate2Verdict | null>;
  /** Veredicto del Gate 3 (revisión de módulo) por módulo, o null si aún no fue auditado. */
  gate3Verdicts?: Record<string, Gate3Verdict | null>;
  /** Manifest de empaquetado del curso (etapa de entrega), o null si aún no fue empaquetado. */
  packageManifest?: PackageManifest | null;
  /** Briefs de overlays por lección, o null si aún no fueron generados. */
  overlayBriefs?: Record<string, OverlayBriefsFile | null>;
}

const POLL_INTERVAL_MS = 2000;

/**
 * El juez de Gate 2 (fire-and-forget en el backend) puede tardar hasta
 * GATE2_TIMEOUT_MIN=20min. Como el job queda en un status estable
 * ('assembled') mientras corre, el polling general (startPolling) no lo
 * recoge. Usamos un polling dedicado por lección tras el POST /gate2.
 */
const GATE2_POLL_INTERVAL_MS = 10_000;
const GATE2_POLL_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * El juez de Gate 3 (revisión de módulo completo, también fire-and-forget
 * en el backend) sigue el mismo patrón que Gate 2: el job se queda en un
 * status estable mientras corre, así que usamos un polling dedicado por
 * módulo tras el POST /gate3, con el mismo intervalo/timeout que Gate 2.
 */
const GATE3_POLL_INTERVAL_MS = GATE2_POLL_INTERVAL_MS;
const GATE3_POLL_TIMEOUT_MS = GATE2_POLL_TIMEOUT_MS;

/** Etapas mostradas en el stepper, en orden. */
type StepKey =
  | "ingest"
  | "probe"
  | "transcribe"
  | "sample"
  | "plan"
  | "prep"
  | "assemble";

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
    const order: StepKey[] = [
      "ingest",
      "probe",
      "transcribe",
      "sample",
      "plan",
      "prep",
      "assemble",
    ];
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

  if (step === "transcribe") {
    if (status === "transcribing") return "active";
    if (
      status === "transcribed" ||
      status === "sampling" ||
      status === "sampled"
    )
      return "done";
    return "pending"; // ingested, probing, probed
  }

  if (step === "sample") {
    if (status === "sampling") return "active";
    if (
      status === "sampled" ||
      status === "planning" ||
      status === "planned"
    )
      return "done";
    return "pending"; // ingested, probing, probed, transcribing, transcribed
  }

  if (step === "plan") {
    if (status === "planning") return "active";
    if (
      status === "planned" ||
      status === "preparing" ||
      status === "prepared"
    )
      return "done";
    return "pending"; // cualquier etapa previa a 'planning'
  }

  if (step === "prep") {
    if (status === "preparing") return "active";
    if (
      status === "prepared" ||
      status === "assembling" ||
      status === "assembled"
    )
      return "done";
    return "pending"; // cualquier etapa previa a 'preparing'
  }

  // step === 'assemble' (etapas 9 + 11: intros + ensamblaje headless)
  if (status === "assembling") return "active";
  if (status === "assembled") return "done";
  return "pending"; // cualquier etapa previa a 'assembling'
}

const STEP_LABELS: Record<StepKey, string> = {
  ingest: "Ingesta",
  probe: "Midiendo",
  transcribe: "Transcribiendo",
  sample: "Muestreando frames",
  plan: "Estructurando (agente)",
  prep: "Preparando corte",
  assemble: "Ensamblando clases",
};

/** Etiqueta en español del veredicto del agente para el badge de cada clip. */
const VERDICT_LABELS: Record<Verdict["verdict"], string> = {
  leccion: "Lección",
  broll: "B-roll",
  descartar: "Descartar",
  otro_curso: "Otro curso",
};

/** Clase de color del badge de veredicto, según la paleta existente. */
const VERDICT_BADGE_CLASS: Record<Verdict["verdict"], string> = {
  leccion: "verdict-badge verdict-badge--leccion",
  broll: "verdict-badge verdict-badge--broll",
  descartar: "verdict-badge verdict-badge--descartar",
  otro_curso: "verdict-badge verdict-badge--otro-curso",
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

/** Formatea segundos como mm:ss para el caption de cada miniatura. */
function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
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
  const [sampling, setSampling] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [assembling, setAssembling] = useState(false);
  const [assembleError, setAssembleError] = useState<string | null>(null);

  // Gate 2 (QA visual post-ensamblaje): se dispara por lección, así que se
  // trackea cuál está corriendo y su error por separado.
  const [gate2Loading, setGate2Loading] = useState<string | null>(null);
  const [gate2Errors, setGate2Errors] = useState<Record<string, string>>({});

  // Gate 3 (revisión de módulo completo): se dispara por moduleId, mismo
  // patrón que Gate 2 (polling dedicado tras el POST, ver handleGate3).
  const [gate3Loading, setGate3Loading] = useState<string | null>(null);
  const [gate3Errors, setGate3Errors] = useState<Record<string, string>>({});

  // Empaquetado del curso (etapa de entrega): POST síncrono, sin polling
  // dedicado — al terminar, loadJob() ya trae el manifest actualizado.
  const [packaging, setPackaging] = useState(false);
  const [packageError, setPackageError] = useState<string | null>(null);

  // Generación de briefs de overlays: POST síncrono, sin polling dedicado.
  const [generatingBriefs, setGeneratingBriefs] = useState(false);
  const [overlayBriefsError, setOverlayBriefsError] = useState<
    string | null
  >(null);
  const [showMaster, setShowMaster] = useState(false);
  const [masterText, setMasterText] = useState<string | null>(null);
  const [masterLoading, setMasterLoading] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);

  // Gate humano de la etapa 6: aprobar/editar la estructura antes de preparar.
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [editingStructure, setEditingStructure] = useState(false);
  const [editStructure, setEditStructure] = useState<StructureJson | null>(
    null
  );
  const [structureJsonText, setStructureJsonText] = useState("");
  const [structureJsonError, setStructureJsonError] = useState<string | null>(
    null
  );
  const [savingStructure, setSavingStructure] = useState(false);
  const [saveStructureError, setSaveStructureError] = useState<string | null>(
    null
  );
  const [structureSavedNotice, setStructureSavedNotice] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Polling dedicado de Gate 2 por lessonId: ver comentario de
  // GATE2_POLL_INTERVAL_MS/GATE2_POLL_TIMEOUT_MS arriba.
  const gate2PollTimersRef = useRef<
    Record<
      string,
      {
        intervalId: ReturnType<typeof setInterval>;
        timeoutId: ReturnType<typeof setTimeout>;
      }
    >
  >({});

  const stopGate2Polling = useCallback((lessonId: string) => {
    const timers = gate2PollTimersRef.current[lessonId];
    if (timers) {
      clearInterval(timers.intervalId);
      clearTimeout(timers.timeoutId);
      delete gate2PollTimersRef.current[lessonId];
    }
  }, []);

  useEffect(() => {
    const timersRef = gate2PollTimersRef;
    return () => {
      Object.keys(timersRef.current).forEach((lessonId) => {
        const timers = timersRef.current[lessonId];
        clearInterval(timers.intervalId);
        clearTimeout(timers.timeoutId);
      });
      timersRef.current = {};
    };
  }, []);

  // Polling dedicado de Gate 3 por moduleId: mismo patrón que Gate 2 (ver
  // comentario de GATE3_POLL_INTERVAL_MS/GATE3_POLL_TIMEOUT_MS arriba).
  const gate3PollTimersRef = useRef<
    Record<
      string,
      {
        intervalId: ReturnType<typeof setInterval>;
        timeoutId: ReturnType<typeof setTimeout>;
      }
    >
  >({});

  const stopGate3Polling = useCallback((moduleId: string) => {
    const timers = gate3PollTimersRef.current[moduleId];
    if (timers) {
      clearInterval(timers.intervalId);
      clearTimeout(timers.timeoutId);
      delete gate3PollTimersRef.current[moduleId];
    }
  }, []);

  useEffect(() => {
    const timersRef = gate3PollTimersRef;
    return () => {
      Object.keys(timersRef.current).forEach((moduleId) => {
        const timers = timersRef.current[moduleId];
        clearInterval(timers.intervalId);
        clearTimeout(timers.timeoutId);
      });
      timersRef.current = {};
    };
  }, []);

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
   * terminó (status distinto de 'sampled'/'error'), programa la siguiente
   * consulta 2s después. Se usa tanto al montar como después de disparar
   * una re-transcripción o un (re)muestreo de frames.
   *
   * Nota: el status 'transcribed' NO se considera terminal en general — el
   * pipeline nuevo lo atraviesa de forma transitoria camino a 'sampling'.
   * Pero un job estancado en 'transcribed' sin manifest (jobs viejos, o
   * mientras el usuario no dispara el muestreo) es un estado ESTABLE: nada
   * lo va a mover sin acción del usuario, así que ahí SÍ paramos el polling
   * en segundo plano para no pegarle a la API cada 2s indefinidamente. El
   * botón "Muestrear frames" (handleSample) reanuda el polling al hacer el
   * POST que dispara la etapa.
   *
   * Lo mismo aplica a 'sampled': es estable mientras el usuario no dispare
   * la etapa de plan (handlePlan reanuda el polling). Una vez que 'planning'
   * arranca, el polling sigue hasta 'planned' o 'error'.
   *
   * Y lo mismo aplica a 'planned': es estable mientras el usuario no
   * dispare la preparación (handlePrep reanuda el polling). Una vez que
   * 'preparing' arranca, el polling sigue hasta 'prepared' o 'error'.
   */
  const startPolling = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    let cancelled = false;

    async function tick() {
      const body = await loadJob();
      if (cancelled) return;

      const status = body?.job.status;
      const stableWithoutManifest =
        status === "transcribed" && body?.manifest === null;
      const finished =
        status === "sampled" ||
        status === "planned" ||
        status === "prepared" ||
        status === "assembled" ||
        status === "error" ||
        stableWithoutManifest;
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

  /**
   * Dispara (o re-dispara) la etapa de muestreo de frames vía
   * POST /api/jobs/<id>/frames. Maneja 409 (pipeline ya corriendo) y 400
   * (status del job no permite muestrear todavía) con mensajes específicos.
   */
  const handleSample = useCallback(async () => {
    setSampleError(null);
    setSampling(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/frames`, {
        method: "POST",
      });
      if (res.status === 409) {
        setSampleError("El proyecto ya se está procesando.");
        return;
      }
      if (res.status === 400) {
        const body = await res.json().catch(() => null);
        setSampleError(
          body?.error ?? "El proyecto todavía no puede muestrear frames."
        );
        return;
      }
      if (!res.ok) {
        setSampleError("No se pudo iniciar el muestreo de frames.");
        return;
      }
      // Reanuda el polling de inmediato para reflejar el nuevo status.
      startPolling();
    } catch {
      setSampleError("No se pudo iniciar el muestreo de frames.");
    } finally {
      setSampling(false);
    }
  }, [jobId, startPolling]);

  /**
   * Dispara (o re-dispara) la etapa de plan (filtro editorial + estructura
   * autónoma del agente) vía POST /api/jobs/<id>/plan. Maneja 409 (pipeline
   * ya corriendo) y 400 (status del job no permite planear todavía) con
   * mensajes específicos.
   */
  const handlePlan = useCallback(async () => {
    setPlanError(null);
    setPlanning(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/plan`, {
        method: "POST",
      });
      if (res.status === 409) {
        setPlanError("El proyecto ya se está procesando.");
        return;
      }
      if (res.status === 400) {
        const body = await res.json().catch(() => null);
        setPlanError(
          body?.error ?? "El proyecto todavía no puede generar la estructura."
        );
        return;
      }
      if (!res.ok) {
        setPlanError("No se pudo iniciar la generación de la estructura.");
        return;
      }
      // Reanuda el polling de inmediato para reflejar el nuevo status.
      startPolling();
    } catch {
      setPlanError("No se pudo iniciar la generación de la estructura.");
    } finally {
      setPlanning(false);
    }
  }, [jobId, startPolling]);

  /**
   * Aprueba la estructura (gate humano de la etapa 6) vía
   * POST /api/jobs/<id>/approve. Refetchea el job para reflejar approval.
   */
  const handleApprove = useCallback(async () => {
    setApproveError(null);
    setApproving(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/approve`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setApproveError(body?.error ?? "No se pudo aprobar la estructura.");
        return;
      }
      await loadJob();
    } catch {
      setApproveError("No se pudo aprobar la estructura.");
    } finally {
      setApproving(false);
    }
  }, [jobId, loadJob]);

  /** Entra en modo edición: clona la estructura actual como working copy. */
  const handleStartEdit = useCallback((structure: StructureJson) => {
    const clone: StructureJson = JSON.parse(JSON.stringify(structure));
    setEditStructure(clone);
    setStructureJsonText(JSON.stringify(clone, null, 2));
    setStructureJsonError(null);
    setSaveStructureError(null);
    setStructureSavedNotice(false);
    setEditingStructure(true);
  }, []);

  /** Sale del modo edición sin guardar; descarta la working copy. */
  const handleCancelEdit = useCallback(() => {
    setEditingStructure(false);
    setEditStructure(null);
    setStructureJsonText("");
    setStructureJsonError(null);
    setSaveStructureError(null);
  }, []);

  /** Actualiza el título de un módulo en la working copy. */
  const handleModuleTitleChange = useCallback(
    (moduleId: string, title: string) => {
      setEditStructure((prev) => {
        if (!prev) return prev;
        const next: StructureJson = {
          ...prev,
          modules: prev.modules.map((m) =>
            m.id === moduleId ? { ...m, title } : m
          ),
        };
        setStructureJsonText(JSON.stringify(next, null, 2));
        return next;
      });
    },
    []
  );

  /** Actualiza el título de una lección en la working copy. */
  const handleLessonTitleChange = useCallback(
    (moduleId: string, lessonId: string, title: string) => {
      setEditStructure((prev) => {
        if (!prev) return prev;
        const next: StructureJson = {
          ...prev,
          modules: prev.modules.map((m) =>
            m.id !== moduleId
              ? m
              : {
                  ...m,
                  lessons: m.lessons.map((l) =>
                    l.id === lessonId ? { ...l, title } : l
                  ),
                }
          ),
        };
        setStructureJsonText(JSON.stringify(next, null, 2));
        return next;
      });
    },
    []
  );

  /**
   * Mueve una lección un lugar hacia arriba/abajo dentro de su módulo,
   * intercambiando el campo `order` con el vecino adyacente (según el orden
   * de despliegue actual).
   */
  const handleReorderLesson = useCallback(
    (moduleId: string, lessonId: string, direction: -1 | 1) => {
      setEditStructure((prev) => {
        if (!prev) return prev;
        const next: StructureJson = {
          ...prev,
          modules: prev.modules.map((m) => {
            if (m.id !== moduleId) return m;
            const sorted = m.lessons.slice().sort((a, b) => a.order - b.order);
            const idx = sorted.findIndex((l) => l.id === lessonId);
            const targetIdx = idx + direction;
            if (idx === -1 || targetIdx < 0 || targetIdx >= sorted.length) {
              return m;
            }
            const a = sorted[idx];
            const b = sorted[targetIdx];
            const aOrder = a.order;
            const bOrder = b.order;
            return {
              ...m,
              lessons: m.lessons.map((l) => {
                if (l.id === a.id) return { ...l, order: bOrder };
                if (l.id === b.id) return { ...l, order: aOrder };
                return l;
              }),
            };
          }),
        };
        setStructureJsonText(JSON.stringify(next, null, 2));
        return next;
      });
    },
    []
  );

  /** Mueve una lección de un módulo a otro (select), al final del destino. */
  const handleMoveLessonToModule = useCallback(
    (fromModuleId: string, lessonId: string, toModuleId: string) => {
      if (fromModuleId === toModuleId) return;
      setEditStructure((prev) => {
        if (!prev) return prev;
        const fromModule = prev.modules.find((m) => m.id === fromModuleId);
        const lesson = fromModule?.lessons.find((l) => l.id === lessonId);
        if (!fromModule || !lesson) return prev;
        const next: StructureJson = {
          ...prev,
          modules: prev.modules.map((m) => {
            if (m.id === fromModuleId) {
              return {
                ...m,
                lessons: m.lessons.filter((l) => l.id !== lessonId),
              };
            }
            if (m.id === toModuleId) {
              const maxOrder = m.lessons.reduce(
                (max, l) => Math.max(max, l.order),
                -1
              );
              return {
                ...m,
                lessons: [...m.lessons, { ...lesson, order: maxOrder + 1 }],
              };
            }
            return m;
          }),
        };
        setStructureJsonText(JSON.stringify(next, null, 2));
        return next;
      });
    },
    []
  );

  /** Aplica el JSON crudo del textarea como nueva working copy. */
  const handleApplyStructureJson = useCallback(() => {
    try {
      const parsed = JSON.parse(structureJsonText) as StructureJson;
      setEditStructure(parsed);
      setStructureJsonError(null);
    } catch {
      setStructureJsonError("JSON inválido: revisá la sintaxis.");
    }
  }, [structureJsonText]);

  /**
   * Guarda la working copy vía PUT /api/jobs/<id>/structure. Al guardar, la
   * aprobación previa queda invalidada (approval vuelve a null en el
   * servidor); se avisa acá con structureSavedNotice.
   */
  const handleSaveStructure = useCallback(async () => {
    if (!editStructure) return;
    setStructureJsonError(null);
    setSaveStructureError(null);
    setSavingStructure(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/structure`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ structure: editStructure }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setSaveStructureError(
          body?.error ?? "No se pudo guardar la estructura."
        );
        return;
      }
      setEditingStructure(false);
      setEditStructure(null);
      setStructureJsonText("");
      setStructureSavedNotice(true);
      await loadJob();
    } catch {
      setSaveStructureError("No se pudo guardar la estructura.");
    } finally {
      setSavingStructure(false);
    }
  }, [editStructure, jobId, loadJob]);

  /**
   * Dispara (o re-dispara) las etapas deterministas de preparación (5A
   * silencio, 5B proxies, 5C cortes) vía POST /api/jobs/<id>/prep. Maneja
   * 409 (pipeline ya corriendo O estructura no aprobada — el body {force}
   * salta la validación de aprobación) y 400 (status del job no permite
   * preparar todavía) con mensajes específicos.
   */
  const handlePrep = useCallback(
    async (force = false) => {
      setPrepError(null);
      setPreparing(true);
      try {
        const res = await fetch(`/api/jobs/${jobId}/prep`, {
          method: "POST",
          ...(force
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ force: true }),
              }
            : {}),
        });
        if (res.status === 409) {
          const body = await res.json().catch(() => null);
          setPrepError(
            body?.error ??
              "El proyecto ya se está procesando o la estructura no está aprobada."
          );
          return;
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => null);
          setPrepError(
            body?.error ?? "El proyecto todavía no puede prepararse."
          );
          return;
        }
        if (!res.ok) {
          setPrepError("No se pudo iniciar la preparación del corte.");
          return;
        }
        // Reanuda el polling de inmediato para reflejar el nuevo status.
        startPolling();
      } catch {
        setPrepError("No se pudo iniciar la preparación del corte.");
      } finally {
        setPreparing(false);
      }
    },
    [jobId, startPolling]
  );

  /**
   * Dispara (o re-dispara) las etapas 9 y 11 (intros + ensamblaje headless)
   * vía POST /api/jobs/<id>/assemble. `force` re-renderiza todas las clases
   * aunque ya tengan un render verificado y vigente; sin force, las clases
   * cuyas entradas no cambiaron se saltan.
   *
   * La UI no elige backend: eso lo decide ASSEMBLY_BACKEND en el servidor.
   */
  const handleAssemble = useCallback(
    async (force = false) => {
      setAssembleError(null);
      setAssembling(true);
      try {
        const res = await fetch(`/api/jobs/${jobId}/assemble`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force }),
        });
        if (res.status === 409) {
          setAssembleError("El proyecto ya se está procesando.");
          return;
        }
        if (res.status === 400) {
          const body = await res.json().catch(() => null);
          setAssembleError(
            body?.error ?? "El proyecto todavía no puede ensamblarse."
          );
          return;
        }
        if (!res.ok) {
          setAssembleError("No se pudo iniciar el ensamblaje.");
          return;
        }
        // Reanuda el polling de inmediato para reflejar el nuevo status.
        startPolling();
      } catch {
        setAssembleError("No se pudo iniciar el ensamblaje.");
      } finally {
        setAssembling(false);
      }
    },
    [jobId, startPolling]
  );

  /**
   * Dispara el QA visual (Gate 2) de una clase ya ensamblada vía
   * POST /api/jobs/<id>/gate2 {lessonId}. El endpoint es fire-and-forget: el
   * juez puede tardar hasta GATE2_TIMEOUT_MIN=20min corriendo en background,
   * y el job se queda en un status estable ('assembled') que el polling
   * general (startPolling) ya no recoge. Por eso, tras el POST, arrancamos
   * un polling dedicado para esta lección (cada GATE2_POLL_INTERVAL_MS) que
   * refetchea el job hasta que gate2Verdicts[lessonId] cambie respecto al
   * valor que tenía justo al arrancar el polling, con un tope de
   * GATE2_POLL_TIMEOUT_MS para no quedar corriendo indefinidamente si algo
   * falla. Se limpia también al desmontar el componente.
   */
  const handleGate2 = useCallback(
    async (lessonId: string) => {
      setGate2Errors((prev) => {
        const next = { ...prev };
        delete next[lessonId];
        return next;
      });
      setGate2Loading(lessonId);
      try {
        const res = await fetch(`/api/jobs/${jobId}/gate2`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lessonId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setGate2Errors((prev) => ({
            ...prev,
            [lessonId]: body?.error ?? "No se pudo correr el QA visual.",
          }));
          return;
        }
        const body = await loadJob();
        const previousVerdict = JSON.stringify(
          body?.gate2Verdicts?.[lessonId] ?? null
        );

        stopGate2Polling(lessonId);
        const intervalId = setInterval(async () => {
          const nextBody = await loadJob();
          const nextVerdict = JSON.stringify(
            nextBody?.gate2Verdicts?.[lessonId] ?? null
          );
          if (nextVerdict !== previousVerdict) {
            stopGate2Polling(lessonId);
          }
        }, GATE2_POLL_INTERVAL_MS);
        const timeoutId = setTimeout(() => {
          stopGate2Polling(lessonId);
        }, GATE2_POLL_TIMEOUT_MS);
        gate2PollTimersRef.current[lessonId] = { intervalId, timeoutId };
      } catch {
        setGate2Errors((prev) => ({
          ...prev,
          [lessonId]: "No se pudo correr el QA visual.",
        }));
      } finally {
        setGate2Loading(null);
      }
    },
    [jobId, loadJob, stopGate2Polling]
  );

  /**
   * Dispara la revisión de módulo completo (Gate 3) vía
   * POST /api/jobs/<id>/gate3 {moduleId}. Fire-and-forget en el backend,
   * igual que Gate 2: tras el POST arrancamos un polling dedicado para este
   * módulo que refetchea el job hasta que gate3Verdicts[moduleId] cambie
   * respecto al valor que tenía justo al arrancar el polling.
   */
  const handleGate3 = useCallback(
    async (moduleId: string) => {
      setGate3Errors((prev) => {
        const next = { ...prev };
        delete next[moduleId];
        return next;
      });
      setGate3Loading(moduleId);
      try {
        const res = await fetch(`/api/jobs/${jobId}/gate3`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ moduleId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setGate3Errors((prev) => ({
            ...prev,
            [moduleId]: body?.error ?? "No se pudo correr la revisión de módulo.",
          }));
          return;
        }
        const body = await loadJob();
        const previousVerdict = JSON.stringify(
          body?.gate3Verdicts?.[moduleId] ?? null
        );

        stopGate3Polling(moduleId);
        const intervalId = setInterval(async () => {
          const nextBody = await loadJob();
          const nextVerdict = JSON.stringify(
            nextBody?.gate3Verdicts?.[moduleId] ?? null
          );
          if (nextVerdict !== previousVerdict) {
            stopGate3Polling(moduleId);
          }
        }, GATE3_POLL_INTERVAL_MS);
        const timeoutId = setTimeout(() => {
          stopGate3Polling(moduleId);
        }, GATE3_POLL_TIMEOUT_MS);
        gate3PollTimersRef.current[moduleId] = { intervalId, timeoutId };
      } catch {
        setGate3Errors((prev) => ({
          ...prev,
          [moduleId]: "No se pudo correr la revisión de módulo.",
        }));
      } finally {
        setGate3Loading(null);
      }
    },
    [jobId, loadJob, stopGate3Polling]
  );

  /**
   * Empaqueta el curso para entrega vía POST /api/jobs/<id>/package {}. A
   * diferencia de Gate 2/3, este endpoint responde de forma síncrona (o con
   * 400 si todavía no hay renders), así que un simple loadJob() tras el
   * POST alcanza para reflejar el manifest actualizado.
   */
  const handlePackage = useCallback(async () => {
    setPackageError(null);
    setPackaging(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/package`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setPackageError(body?.error ?? "No se pudo empaquetar el curso.");
        return;
      }
      await loadJob();
    } catch {
      setPackageError("No se pudo empaquetar el curso.");
    } finally {
      setPackaging(false);
    }
  }, [jobId, loadJob]);

  /**
   * Genera los briefs de overlays de todas las lecciones vía
   * POST /api/jobs/<id>/overlay-briefs {}. Igual que el empaquetado,
   * responde de forma síncrona, así que un simple loadJob() alcanza.
   */
  const handleOverlayBriefs = useCallback(async () => {
    setOverlayBriefsError(null);
    setGeneratingBriefs(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/overlay-briefs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setOverlayBriefsError(
          body?.error ?? "No se pudieron generar los briefs de overlays."
        );
        return;
      }
      await loadJob();
    } catch {
      setOverlayBriefsError("No se pudieron generar los briefs de overlays.");
    } finally {
      setGeneratingBriefs(false);
    }
  }, [jobId, loadJob]);

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

  const {
    job,
    media,
    progress,
    summary,
    manifest,
    structure,
    approval,
    audit,
    decisiones,
    silence,
    cuts,
    prepProgress,
    assemblyProgress,
    renders,
    gate2Verdicts,
    gate3Verdicts,
    packageManifest,
    overlayBriefs,
  } = data;
  const isError = job.status === "error";
  // El job puede reintentar solo el plan (sin re-transcribir) si falló
  // estando en 'error' pero ya tiene los prerequisitos del plan generados
  // en disco: frames/manifest.json (proxy de que probe/transcribe/frames ya
  // corrieron con éxito). Debe coincidir con el criterio tolerante de
  // hasPlanPrerequisites en src/lib/pipeline.ts.
  const canRetryPlanOnly = isError && manifest !== null;
  // El job puede reintentar solo la preparación (sin re-planear) si falló
  // estando en 'error' pero ya tiene el prerequisito real de la preparación
  // generado en disco: plan/structure.json (proxy de que la etapa de plan
  // terminó). Debe coincidir con el criterio tolerante de
  // hasPrepPrerequisites en src/lib/pipeline.ts.
  const canRetryPrepOnly = isError && structure !== null;
  // El resumen final se muestra en 'transcribed' (jobs viejos o mientras
  // arranca el muestreo), 'sampled' (frames ya generados), 'planning'/
  // 'planned' (la etapa de plan corre después del muestreo) y también
  // 'preparing'/'prepared' (las etapas 5A/5B/5C corren después del plan),
  // ya que todo lo previo ya está disponible en cualquiera de esos estados.
  const isDone =
    job.status === "transcribed" ||
    job.status === "sampled" ||
    job.status === "planning" ||
    job.status === "planned" ||
    job.status === "preparing" ||
    job.status === "prepared" ||
    job.status === "assembling" ||
    job.status === "assembled";
  // Compat jobs viejos: sin manifest y sin estar corriendo el muestreo, se
  // ofrece el botón para dispararlo manualmente en vez de asumir que sigue
  // "procesando".
  const canSampleFrames = job.status === "transcribed" && manifest === null;
  const canResampleFrames = job.status === "sampled";
  // Compat: un job 'sampled' sin structure.json todavía es un estado
  // estable — se ofrece el botón para disparar la etapa de plan a demanda.
  const canPlan = job.status === "sampled" && structure === null;
  const canReplan = structure !== null;
  // 'planned' sin cuts todavía es un estado estable — se ofrece el botón
  // para disparar la preparación (5A/5B/5C) a demanda. Una vez que ya hay
  // cuts (job 'prepared', o 'preparing' en curso), el botón pasa a
  // "Re-preparar corte".
  const canPrep = job.status === "planned" && cuts === null;
  const canReprep = cuts !== null;
  // El ensamblaje se ofrece desde que hay cortes en disco: 'prepared' (o
  // 'assembling'/'assembled' para re-ensamblar), y también en 'error' si los
  // cortes ya existen (misma tolerancia que hasAssemblyPrerequisites).
  const canAssemble =
    cuts !== null &&
    (job.status === "prepared" ||
      job.status === "assembling" ||
      job.status === "assembled" ||
      job.status === "error");

  const progressFiles = progress?.files ?? {};
  const totalFiles = job.files.length;
  const doneFiles = Object.values(progressFiles).filter(
    (f) => f.status === "done" || f.status === "error"
  ).length;

  // Sub-progreso de proxies (5B) dentro de la etapa 'preparing': cuenta
  // cuántos clips ya terminaron (done o error) sobre el total de clips que
  // necesitan proxy, leído de progress/prep-progress.json.
  // Progreso X/N del ensamblaje (etapas 9+11): una clase cuenta como
  // terminada cuando quedó 'done', 'skipped' (ya tenía render vigente) o
  // 'error'. Se lee de progress/assembly-progress.json.
  const assemblyLessons = Object.entries(assemblyProgress?.lessons ?? {});
  const assemblyTotal = assemblyProgress?.total ?? 0;
  const assemblyDone = assemblyLessons.filter(
    ([, l]) => l.status === "done" || l.status === "skipped" || l.status === "error"
  ).length;
  // Solo se ofrece reproducir lo que tiene sidecar 'complete': la existencia
  // del .mp4 nunca alcanza (ver assembly/verify.ts).
  const completedRenders = renders ?? [];
  const rendersByLesson = new Map(completedRenders.map((r) => [r.lessonId, r]));
  // El empaquetado se ofrece desde que hay al menos un render verificado
  // (el backend responde 400 sin renders — ver POST /package).
  const canPackage = completedRenders.length > 0;
  // Título legible por lección, para las tarjetas de reproducción.
  const lessonTitles = new Map<string, string>();
  for (const module of structure?.modules ?? []) {
    for (const lesson of module.lessons) {
      lessonTitles.set(lesson.id, lesson.title);
    }
  }

  const prepFiles = prepProgress?.files ?? {};
  const prepTotalFiles = Object.keys(prepFiles).length;
  const prepDoneFiles = Object.values(prepFiles).filter(
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
          <div className="stepper-actions">
            {canRetryPlanOnly && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handlePlan}
                disabled={planning}
              >
                {planning
                  ? "Reintentando plan…"
                  : "Reintentar plan (sin re-transcribir)"}
              </button>
            )}
            {canRetryPrepOnly && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handlePrep()}
                disabled={preparing}
              >
                {preparing ? "Reintentando preparación…" : "Reintentar preparación"}
              </button>
            )}
            <button
              className="btn"
              type="button"
              onClick={handleRetranscribe}
              disabled={retranscribing}
            >
              {retranscribing
                ? "Reintentando…"
                : "Reintentar pipeline completo"}
            </button>
          </div>
          {planError && <p className="stepper-error-msg">{planError}</p>}
          {prepError && <p className="stepper-error-msg">{prepError}</p>}
          {retranscribeError && (
            <p className="stepper-error-msg">{retranscribeError}</p>
          )}
        </div>
      )}

      <ol className="stepper">
        {(
          [
            "ingest",
            "probe",
            "transcribe",
            "sample",
            "plan",
            "prep",
            "assemble",
          ] as StepKey[]
        ).map((step) => {
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
                {step === "prep" &&
                  job.status === "preparing" &&
                  prepTotalFiles > 0 &&
                  ` (proxies ${prepDoneFiles}/${prepTotalFiles})`}
                {step === "assemble" &&
                  job.status === "assembling" &&
                  assemblyTotal > 0 &&
                  ` (${assemblyDone}/${assemblyTotal})`}
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
            {(canSampleFrames || canResampleFrames) && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleSample}
                disabled={sampling}
              >
                {sampling
                  ? "Muestreando…"
                  : canResampleFrames
                    ? "Re-muestrear frames"
                    : "Muestrear frames"}
              </button>
            )}
            {(canPlan || canReplan) && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handlePlan}
                disabled={planning}
              >
                {planning
                  ? "Generando estructura…"
                  : canReplan
                    ? "Re-generar estructura"
                    : "Generar estructura (agente)"}
              </button>
            )}
            {(canPrep || canReprep) && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handlePrep()}
                disabled={preparing}
              >
                {preparing
                  ? "Preparando…"
                  : canReprep
                    ? "Re-preparar corte"
                    : "Preparar corte (silencio + proxies + cortes)"}
              </button>
            )}
            {(canPrep || canReprep) && approval === null && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "La estructura todavía no fue aprobada. ¿Preparar el corte de todos modos?"
                    )
                  ) {
                    handlePrep(true);
                  }
                }}
                disabled={preparing}
              >
                Preparar sin aprobar
              </button>
            )}
            {canAssemble && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handleAssemble(false)}
                disabled={assembling || job.status === "assembling"}
              >
                {assembling || job.status === "assembling"
                  ? "Ensamblando…"
                  : "Ensamblar clases (intros + corte)"}
              </button>
            )}
          </div>
          {retranscribeError && (
            <p className="stepper-error-msg">{retranscribeError}</p>
          )}
          {sampleError && <p className="stepper-error-msg">{sampleError}</p>}
          {planError && <p className="stepper-error-msg">{planError}</p>}
          {prepError && <p className="stepper-error-msg">{prepError}</p>}
          {assembleError && (
            <p className="stepper-error-msg">{assembleError}</p>
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

          {manifest && manifest.clips.length > 0 && (
            <section className="frames-section">
              <h2>Frames por clip</h2>
              {manifest.clips.map((clip) => (
                <details className="clip-details" key={clip.filename}>
                  <summary className="clip-summary">
                    <span>{clip.filename}</span>
                    {!clip.narration && (
                      <span className="badge">🎬 B-roll</span>
                    )}
                    <span className="badge">{clip.frames.length} frames</span>
                  </summary>
                  <div className="frames-grid">
                    {clip.frames.map((frame) => (
                      <figure className="frame-thumb" key={frame.file}>
                        <img
                          loading="lazy"
                          src={`/api/jobs/${jobId}/frames/${frame.file}`}
                          alt={`${clip.filename} — ${formatTimestamp(frame.timeSeconds)}`}
                        />
                        <figcaption className="frame-caption">
                          {formatTimestamp(frame.timeSeconds)}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          )}

          {structure && (
            <section className="audit-section">
              <h2>Auditoría de la estructura (agente)</h2>
              <p className="audit-hint">
                Vista de lo que decidió el agente autónomo de la etapa 4.
                Aprobá la estructura antes de preparar el corte, o editala
                si hace falta ajustar módulos, clases o su orden.
              </p>

              <div className="stepper-actions">
                <span className="badge">
                  {approval
                    ? `Estructura aprobada ${new Date(
                        approval.approvedAt
                      ).toLocaleString()}`
                    : "Pendiente de aprobación"}
                </span>
                {approval === null && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={handleApprove}
                    disabled={approving}
                  >
                    {approving ? "Aprobando…" : "Aprobar estructura"}
                  </button>
                )}
                {!editingStructure && (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => handleStartEdit(structure)}
                  >
                    Editar
                  </button>
                )}
              </div>
              {approveError && (
                <p className="stepper-error-msg">{approveError}</p>
              )}
              {structureSavedNotice && !editingStructure && (
                <p className="stepper-error-msg">
                  La estructura se guardó: la aprobación quedó pendiente de
                  nuevo.
                </p>
              )}

              <h3>{structure.courseTitle}</h3>

              {editingStructure && editStructure ? (
                <>
                  <div className="structure-tree">
                    {editStructure.modules
                      .slice()
                      .sort((a, b) => a.order - b.order)
                      .map((mod) => (
                        <div className="structure-module" key={mod.id}>
                          <div className="field">
                            <label htmlFor={`mod-title-${mod.id}`}>
                              Módulo
                            </label>
                            <input
                              id={`mod-title-${mod.id}`}
                              className="input"
                              type="text"
                              value={mod.title}
                              onChange={(e) =>
                                handleModuleTitleChange(
                                  mod.id,
                                  e.target.value
                                )
                              }
                            />
                          </div>
                          {mod.topics.length > 0 && (
                            <p className="structure-module-topics">
                              {mod.topics.join(" · ")}
                            </p>
                          )}
                          <ul className="structure-lesson-list">
                            {mod.lessons
                              .slice()
                              .sort((a, b) => a.order - b.order)
                              .map((lesson, idx, sortedLessons) => (
                                <li
                                  className="structure-lesson"
                                  key={lesson.id}
                                >
                                  <div className="field">
                                    <label
                                      htmlFor={`lesson-title-${lesson.id}`}
                                    >
                                      Clase
                                    </label>
                                    <input
                                      id={`lesson-title-${lesson.id}`}
                                      className="input"
                                      type="text"
                                      value={lesson.title}
                                      onChange={(e) =>
                                        handleLessonTitleChange(
                                          mod.id,
                                          lesson.id,
                                          e.target.value
                                        )
                                      }
                                    />
                                  </div>
                                  <div className="row">
                                    <button
                                      className="btn btn-secondary"
                                      type="button"
                                      onClick={() =>
                                        handleReorderLesson(
                                          mod.id,
                                          lesson.id,
                                          -1
                                        )
                                      }
                                      disabled={idx === 0}
                                    >
                                      ↑
                                    </button>
                                    <button
                                      className="btn btn-secondary"
                                      type="button"
                                      onClick={() =>
                                        handleReorderLesson(
                                          mod.id,
                                          lesson.id,
                                          1
                                        )
                                      }
                                      disabled={
                                        idx === sortedLessons.length - 1
                                      }
                                    >
                                      ↓
                                    </button>
                                    <select
                                      className="select"
                                      value={mod.id}
                                      onChange={(e) =>
                                        handleMoveLessonToModule(
                                          mod.id,
                                          lesson.id,
                                          e.target.value
                                        )
                                      }
                                    >
                                      {editStructure.modules
                                        .slice()
                                        .sort((a, b) => a.order - b.order)
                                        .map((m2) => (
                                          <option key={m2.id} value={m2.id}>
                                            {m2.title}
                                          </option>
                                        ))}
                                    </select>
                                  </div>
                                  <ul className="structure-segment-list">
                                    {lesson.segments.map((seg, idx2) => (
                                      <li
                                        className="structure-segment"
                                        key={`${seg.clip}-${idx2}`}
                                      >
                                        <span className="badge">
                                          {seg.clip}
                                        </span>{" "}
                                        <span className="structure-segment-range">
                                          {formatTimestamp(seg.startSeconds)}–
                                          {formatTimestamp(seg.endSeconds)}
                                        </span>{" "}
                                        <span className="structure-segment-topic">
                                          {seg.topic}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </li>
                              ))}
                          </ul>
                        </div>
                      ))}
                  </div>

                  <details className="decisiones-details">
                    <summary>Editar JSON completo</summary>
                    <textarea
                      className="input"
                      rows={20}
                      value={structureJsonText}
                      onChange={(e) => setStructureJsonText(e.target.value)}
                    />
                    <div className="stepper-actions">
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={handleApplyStructureJson}
                      >
                        Aplicar JSON
                      </button>
                    </div>
                    {structureJsonError && (
                      <p className="stepper-error-msg">
                        {structureJsonError}
                      </p>
                    )}
                  </details>

                  <div className="stepper-actions">
                    <button
                      className="btn"
                      type="button"
                      onClick={handleSaveStructure}
                      disabled={savingStructure}
                    >
                      {savingStructure ? "Guardando…" : "Guardar"}
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={handleCancelEdit}
                      disabled={savingStructure}
                    >
                      Cancelar
                    </button>
                  </div>
                  {saveStructureError && (
                    <p className="stepper-error-msg">{saveStructureError}</p>
                  )}
                </>
              ) : (
                <div className="structure-tree">
                  {structure.modules
                    .slice()
                    .sort((a, b) => a.order - b.order)
                    .map((mod) => (
                      <div className="structure-module" key={mod.id}>
                        <h4>{mod.title}</h4>
                        {mod.topics.length > 0 && (
                          <p className="structure-module-topics">
                            {mod.topics.join(" · ")}
                          </p>
                        )}
                        <ul className="structure-lesson-list">
                          {mod.lessons
                            .slice()
                            .sort((a, b) => a.order - b.order)
                            .map((lesson) => (
                              <li
                                className="structure-lesson"
                                key={lesson.id}
                              >
                                <span className="structure-lesson-title">
                                  {lesson.title}
                                </span>
                                <ul className="structure-segment-list">
                                  {lesson.segments.map((seg, idx) => (
                                    <li
                                      className="structure-segment"
                                      key={`${seg.clip}-${idx}`}
                                    >
                                      <span className="badge">
                                        {seg.clip}
                                      </span>{" "}
                                      <span className="structure-segment-range">
                                        {formatTimestamp(seg.startSeconds)}–
                                        {formatTimestamp(seg.endSeconds)}
                                      </span>{" "}
                                      <span className="structure-segment-topic">
                                        {seg.topic}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))}
                </div>
              )}

              {audit && audit.clips.length > 0 && (
                <div className="clip-cards">
                  {audit.clips
                    .slice()
                    .sort((a, b) => {
                      // Baja confianza primero.
                      if (a.lowConfidence !== b.lowConfidence) {
                        return a.lowConfidence ? -1 : 1;
                      }
                      return a.confianza - b.confianza;
                    })
                    .map((clipAudit) => {
                      const clipFrames =
                        manifest?.clips.find(
                          (c) => c.filename === clipAudit.clip
                        )?.frames ?? [];
                      return (
                        <div
                          className={`clip-card${
                            clipAudit.lowConfidence
                              ? " clip-card--low-confidence"
                              : ""
                          }`}
                          key={clipAudit.clip}
                        >
                          <div className="clip-card-header">
                            <span className="clip-card-filename">
                              {clipAudit.clip}
                            </span>
                            <span
                              className={VERDICT_BADGE_CLASS[clipAudit.verdict]}
                            >
                              {VERDICT_LABELS[clipAudit.verdict]}
                            </span>
                            {clipAudit.lowConfidence && (
                              <span className="badge badge-warning">
                                ⚠ baja confianza
                              </span>
                            )}
                          </div>

                          <div className="confidence-bar">
                            <div
                              className="confidence-bar-fill"
                              style={{
                                width: `${Math.round(clipAudit.confianza * 100)}%`,
                              }}
                            />
                          </div>
                          <p className="confidence-label">
                            Confianza: {Math.round(clipAudit.confianza * 100)}%
                          </p>

                          {clipAudit.heuristicas.length > 0 && (
                            <div className="heuristic-chips">
                              {clipAudit.heuristicas.map((h) => (
                                <span className="heuristic-chip" key={h}>
                                  {h}
                                </span>
                              ))}
                            </div>
                          )}

                          {clipAudit.pidioFramesExtra && (
                            <p className="frames-extra-marker">
                              🔍 pidió más frames
                              {clipAudit.verdictAntes &&
                                clipAudit.verdictDespues && (
                                  <>
                                    {" "}
                                    ({VERDICT_LABELS[clipAudit.verdictAntes]} →{" "}
                                    {VERDICT_LABELS[clipAudit.verdictDespues]})
                                  </>
                                )}
                              {clipAudit.queCambio && (
                                <span className="frames-extra-detail">
                                  {" "}
                                  — {clipAudit.queCambio}
                                </span>
                              )}
                            </p>
                          )}

                          {clipFrames.length > 0 && (
                            <div className="frames-grid frames-grid--mini">
                              {clipFrames.map((frame) => (
                                <figure
                                  className="frame-thumb"
                                  key={frame.file}
                                >
                                  <img
                                    loading="lazy"
                                    src={`/api/jobs/${jobId}/frames/${frame.file}`}
                                    alt={`${clipAudit.clip} — ${formatTimestamp(frame.timeSeconds)}`}
                                  />
                                  <figcaption className="frame-caption">
                                    {formatTimestamp(frame.timeSeconds)}
                                  </figcaption>
                                </figure>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}

              {structure.apartados.length > 0 && (
                <section className="apartados-section">
                  <h3>Apartados</h3>
                  <div>
                    {structure.apartados.map((v) => (
                      <div className="row apartado-row" key={v.clip}>
                        <span>
                          <span className="badge">{v.clip}</span>{" "}
                          <span
                            className={VERDICT_BADGE_CLASS[v.verdict]}
                          >
                            {VERDICT_LABELS[v.verdict]}
                          </span>
                          {v.curso && (
                            <span className="badge">curso: {v.curso}</span>
                          )}
                        </span>
                        <span className="apartado-razon">{v.razon}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {decisiones && (
                <details className="decisiones-details">
                  <summary>decisiones.md</summary>
                  <pre className="master-pre">{decisiones}</pre>
                </details>
              )}

              {audit && (
                <p className="usage-line">
                  Modelo {audit.model} — tokens in {audit.usage.inputTokens} /
                  out {audit.usage.outputTokens} / cache{" "}
                  {audit.usage.cacheReadTokens} — {audit.framesCalls.length}{" "}
                  llamadas a frames extra
                </p>
              )}
            </section>
          )}

          {(silence || cuts) && (
            <section className="prep-section">
              <h2>Preparación del corte</h2>
              <p className="audit-hint">
                Resultado de las etapas deterministas 5A/5B/5C: silencio
                medido por clip, proxies de edición y cortes propuestos a
                partir de los huecos de la transcripción. Todavía no hay
                reproducción de video acá, solo los números y la lista de
                cortes para auditar.
              </p>

              {silence && silence.clips.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Clip</th>
                      <th>Silencios</th>
                      <th>Seg. silentes</th>
                      <th>Shrink</th>
                    </tr>
                  </thead>
                  <tbody>
                    {silence.clips.map((clip) => (
                      <tr key={clip.filename}>
                        <td>
                          {clip.filename}
                          {clip.skipped && (
                            <span className="badge" title="Demo: sin recorte de silencio interno">
                              {" "}
                              🖐 demo sin recorte
                            </span>
                          )}
                        </td>
                        <td>{clip.count}</td>
                        <td>{clip.totalSilentSeconds.toFixed(1)}s</td>
                        <td>{(clip.shrinkRatio * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {cuts && cuts.length > 0 && (
                <div className="cuts-lessons">
                  {cuts.map((cutsFile) => {
                    const totalCuts = cutsFile.clips.reduce(
                      (sum, c) => sum + c.cuts.length,
                      0
                    );
                    const rawSeconds = cutsFile.clips.reduce(
                      (sum, c) => sum + c.stats.rawSeconds,
                      0
                    );
                    const projectedSeconds = cutsFile.clips.reduce(
                      (sum, c) => sum + c.stats.projectedSeconds,
                      0
                    );
                    return (
                      <div className="row cuts-lesson-row" key={cutsFile.lessonId}>
                        <div className="cuts-lesson-summary">
                          <span className="structure-lesson-title">
                            {cutsFile.lessonTitle}
                          </span>
                          <span className="badge">{totalCuts} cortes</span>
                          <span className="badge">
                            {formatTimestamp(rawSeconds)} →{" "}
                            {formatTimestamp(projectedSeconds)}
                          </span>
                        </div>
                        <details className="cuts-details">
                          <summary>Ver cortes por clip</summary>
                          {cutsFile.clips.map((clip, clipIdx) => (
                            <div
                              className="cuts-clip"
                              key={`${clip.clip}-${clipIdx}`}
                            >
                              <p className="cuts-clip-title">
                                <span className="badge">{clip.clip}</span>{" "}
                                {clip.kind === "demo" && (
                                  <span className="badge">🖐 demo</span>
                                )}
                              </p>
                              {clip.cuts.length === 0 ? (
                                <p className="cuts-empty">Sin cortes.</p>
                              ) : (
                                <ul className="cuts-list">
                                  {clip.cuts.map((cut, cutIdx) => (
                                    <li key={`${cut.startFrame}-${cutIdx}`}>
                                      frames {cut.startFrame}–{cut.endFrame} (
                                      {formatTimestamp(cut.startSeconds)}–
                                      {formatTimestamp(cut.endSeconds)})
                                      {cut.confirmedBySilence && (
                                        <span className="badge">
                                          {" "}
                                          ✓ silencio
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ))}
                        </details>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {(assemblyProgress || completedRenders.length > 0) && (
            <section className="assembly-section">
              <h2>Clases ensambladas</h2>
              <p className="audit-hint">
                Etapas 9 y 11: intro por clase + concatenación de los tramos
                &quot;keep&quot; (el corte de silencios ya calculado), en
                1080p/30. Solo se listan renders VERIFICADOS como completos
                (frames contados con ffprobe contra los esperados): un archivo
                a medio escribir nunca aparece acá.
                {assemblyProgress?.backend
                  ? ` Backend: ${assemblyProgress.backend}.`
                  : ""}
              </p>

              {assemblyTotal > 0 && (
                <p className="assembly-progress">
                  {assemblyDone}/{assemblyTotal} clases
                  {job.status === "assembling" ? " (ensamblando…)" : ""}
                </p>
              )}

              <div className="assembly-grid">
                {(assemblyLessons.length > 0
                  ? assemblyLessons.map(([lessonId, lesson]) => ({
                      lessonId,
                      title: lesson.title,
                      status: lesson.status,
                      frame: lesson.frame,
                      totalFrames: lesson.totalFrames,
                      error: lesson.error,
                    }))
                  : completedRenders.map((r) => ({
                      lessonId: r.lessonId,
                      title: lessonTitles.get(r.lessonId) ?? r.lessonId,
                      status: "done" as const,
                      frame: r.actualFrames,
                      totalFrames: r.expectedFrames,
                      error: undefined,
                    }))
                ).map((lesson) => {
                  const render = rendersByLesson.get(lesson.lessonId);
                  const pct =
                    lesson.totalFrames && lesson.totalFrames > 0
                      ? Math.round(
                          ((lesson.frame ?? 0) / lesson.totalFrames) * 100
                        )
                      : 0;

                  return (
                    <div className="assembly-card" key={lesson.lessonId}>
                      <div className="assembly-card-head">
                        <strong>{lesson.title}</strong>
                        <span className="assembly-card-id">
                          {lesson.lessonId}
                        </span>
                      </div>

                      {lesson.status === "error" && (
                        <p className="stepper-error-msg">
                          {lesson.error ?? "Falló el ensamblaje de esta clase."}
                        </p>
                      )}

                      {(lesson.status === "intro" ||
                        lesson.status === "assembling" ||
                        lesson.status === "pending") && (
                        <p className="assembly-card-status">
                          <span className="spinner spinner-inline" />{" "}
                          {lesson.status === "intro"
                            ? "renderizando intro…"
                            : lesson.status === "assembling"
                              ? `ensamblando… ${pct}%`
                              : "en cola"}
                        </p>
                      )}

                      {/* La reproducción depende del sidecar, no del status:
                          un render de una corrida anterior sigue siendo
                          reproducible aunque esta corrida todavía no llegue
                          a esta clase. */}
                      {render ? (
                        <>
                          <video
                            className="assembly-video"
                            controls
                            preload="metadata"
                            src={`/api/jobs/${jobId}/render/${lesson.lessonId}.mp4`}
                          />
                          <p className="assembly-card-meta">
                            {formatDuration(render.durationSeconds)} ·{" "}
                            {render.width}x{render.height} · {render.fps}fps ·{" "}
                            {render.actualFrames} frames ·{" "}
                            {(render.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                            {lesson.status === "skipped"
                              ? " · reutilizado (sin cambios)"
                              : ""}
                          </p>

                          {(() => {
                            const verdict =
                              gate2Verdicts?.[lesson.lessonId] ?? null;
                            const running = gate2Loading === lesson.lessonId;
                            const error = gate2Errors[lesson.lessonId];
                            return (
                              <div className="gate2-block">
                                <div className="stepper-actions">
                                  {verdict === null && (
                                    <span className="badge">— sin QA</span>
                                  )}
                                  {verdict?.verdict === "APPROVED" && (
                                    <span className="badge">
                                      ✅ APROBADA
                                    </span>
                                  )}
                                  {verdict?.verdict === "REJECTED" && (
                                    <span className="badge badge-error">
                                      ❌ RECHAZADA (
                                      {verdict.problemas.length} problema
                                      {verdict.problemas.length === 1
                                        ? ""
                                        : "s"}
                                      )
                                    </span>
                                  )}
                                  <button
                                    className="btn btn-secondary"
                                    type="button"
                                    onClick={() =>
                                      handleGate2(lesson.lessonId)
                                    }
                                    disabled={running}
                                  >
                                    {running ? "Corriendo QA…" : "QA visual"}
                                  </button>
                                </div>
                                {error && (
                                  <p className="stepper-error-msg">{error}</p>
                                )}
                                {verdict?.verdict === "REJECTED" &&
                                  verdict.problemas.length > 0 && (
                                    <details className="cuts-details">
                                      <summary>
                                        Ver problemas detectados
                                      </summary>
                                      <ul className="cuts-list">
                                        {verdict.problemas.map(
                                          (p, idx) => (
                                            <li key={`${p.frame}-${idx}`}>
                                              frame {p.frame} — {p.tipo} (
                                              {p.severidad}): {p.detalle}
                                            </li>
                                          )
                                        )}
                                      </ul>
                                    </details>
                                  )}
                              </div>
                            );
                          })()}
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {canAssemble && (
                <div className="stepper-actions">
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => handleAssemble(false)}
                    disabled={assembling || job.status === "assembling"}
                  >
                    {assembling || job.status === "assembling"
                      ? "Ensamblando…"
                      : "Ensamblar clases (intros + corte)"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => handleAssemble(true)}
                    disabled={assembling || job.status === "assembling"}
                    title="Ignora los renders existentes y vuelve a renderizar todas las clases"
                  >
                    Re-ensamblar todo
                  </button>
                </div>
              )}
              {assembleError && (
                <p className="stepper-error-msg">{assembleError}</p>
              )}
            </section>
          )}

          {structure && (
            <section className="gate3-section">
              <h2>Revisión de módulo (Gate 3)</h2>
              <p className="audit-hint">
                Auditoría de coherencia sobre el módulo completo, una vez que
                sus clases ya están ensambladas.
              </p>
              <div className="gate3-grid">
                {structure.modules.map((module) => {
                  const verdict = gate3Verdicts?.[module.id] ?? null;
                  const running = gate3Loading === module.id;
                  const error = gate3Errors[module.id];
                  return (
                    <div className="assembly-card" key={module.id}>
                      <div className="assembly-card-head">
                        <strong>{module.title}</strong>
                        <span className="assembly-card-id">{module.id}</span>
                      </div>
                      <div className="stepper-actions">
                        {verdict === null && (
                          <span className="badge">— sin revisión</span>
                        )}
                        {verdict?.verdict === "APPROVED" && (
                          <span className="badge">✅ APROBADO</span>
                        )}
                        {verdict?.verdict === "REJECTED" && (
                          <span className="badge badge-error">
                            ❌ RECHAZADO ({verdict.hallazgos.length} hallazgo
                            {verdict.hallazgos.length === 1 ? "" : "s"})
                          </span>
                        )}
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => handleGate3(module.id)}
                          disabled={running}
                        >
                          {running ? "Corriendo revisión…" : "Revisión de módulo"}
                        </button>
                      </div>
                      {error && <p className="stepper-error-msg">{error}</p>}
                      {verdict?.verdict === "REJECTED" &&
                        verdict.hallazgos.length > 0 && (
                          <details className="cuts-details">
                            <summary>Ver hallazgos detectados</summary>
                            <ul className="cuts-list">
                              {verdict.hallazgos.map((h, idx) => (
                                <li key={`${h.tipo}-${idx}`}>
                                  {h.lessonId ? `${h.lessonId} — ` : ""}
                                  {h.tipo} ({h.severidad}): {h.detalle}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="delivery-section">
            <h2>Entrega</h2>
            <p className="audit-hint">
              Empaqueta el curso completo (renders + notas) en un único
              directorio de entrega.
            </p>
            <div className="stepper-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handlePackage}
                disabled={!canPackage || packaging}
                title={
                  canPackage
                    ? undefined
                    : "Todavía no hay clases renderizadas para empaquetar"
                }
              >
                {packaging ? "Empaquetando…" : "Empaquetar curso"}
              </button>
            </div>
            {packageError && (
              <p className="stepper-error-msg">{packageError}</p>
            )}
            {packageManifest && (
              <div className="package-result">
                <p className="assembly-card-meta">
                  {packageManifest.courseDir}
                </p>
                <ul className="cuts-list">
                  {packageManifest.lessons.map((l) => (
                    <li key={l.lessonId}>
                      {l.moduleId} / {l.lessonId} — {l.fileName}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="overlays-section">
            <h2>Briefs de overlays</h2>
            <p className="audit-hint">
              Genera los briefs de overlays visuales (datos/hechos a resaltar
              durante la clase) para todas las lecciones de la estructura.
            </p>
            <div className="stepper-actions">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleOverlayBriefs}
                disabled={generatingBriefs}
              >
                {generatingBriefs
                  ? "Generando briefs…"
                  : "Generar briefs de overlays"}
              </button>
            </div>
            {overlayBriefsError && (
              <p className="stepper-error-msg">{overlayBriefsError}</p>
            )}
            {overlayBriefs &&
              Object.entries(overlayBriefs)
                .filter(([, file]) => file !== null)
                .map(([lessonId, file]) => (
                  <details className="cuts-details" key={lessonId}>
                    <summary>
                      {lessonTitles.get(lessonId) ?? lessonId} (
                      {file?.briefs.length ?? 0} brief
                      {file?.briefs.length === 1 ? "" : "s"})
                    </summary>
                    <ul className="cuts-list">
                      {file?.briefs.map((b) => (
                        <li key={b.key}>
                          {b.key} — {b.fact} (t={b.at_seconds}s)
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
          </section>
        </section>
      )}
    </main>
  );
}
