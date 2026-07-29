"use client";

/**
 * Wizard del job (frontend v2) — LA herramienta con la que el usuario opera
 * el pipeline paso a paso (FLUJO-V2.md fase 2).
 *
 * Riel vertical de 8 pasos en español:
 *   1 Subir ZIP        — resumen de lo ingerido (el upload vive en el home).
 *   2 Transcripción    — probe + whisper + muestreo de frames, X/N en vivo.
 *   3 Estructura       — agente etapa 4 + GATE HUMANO (aprobar / editar).
 *   4 Preparación      — silencio, proxies, cortes, captions + auditoría IA.
 *   5 Overlays         — briefs → imágenes (CDP) → Gate 1 → timeline.
 *   6 Ensamblaje       — intros + render por clase, reproducción del MP4.
 *   7 QA               — Gate 2 por clase (o todas) + Gate 3 por módulo.
 *   8 Entrega          — empaquetado en deliver/ + curso navegable.
 *
 * Cada paso muestra estado (pendiente/en curso/listo/error), progreso X/N en
 * tiempo real (polling cada 2 s, mismo patrón v1), tiempo transcurrido por
 * etapa (timestamps de job.json `stages`) y el botón de la siguiente etapa
 * habilitado SOLO cuando la previa terminó. `run-all` queda escondido como
 * "modo experto" al pie, con confirmación.
 *
 * Todos los endpoints y su semántica (409 corriendo, 400 prerequisito,
 * fire-and-forget con polling dedicado para los gates) se conservan de la
 * UI v1 — ver el historial de este archivo para el detalle fino de cada uno.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
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
import { StepCard, StepState } from "@/components/wizard/StepCard";
import { ProgressBar } from "@/components/wizard/ProgressBar";
import { StructureEditor } from "@/components/wizard/StructureEditor";
import {
  elapsedOf,
  formatDuration,
  formatElapsed,
  formatTimestamp,
  sumElapsed,
} from "@/components/wizard/format";

/* ------------------------------------------------------------------ *
 * Formas de datos que la API expone y aún no viven en lib/types.
 * ------------------------------------------------------------------ */

interface Gate2Problema {
  frame: number;
  tipo: string;
  detalle: string;
  severidad: string;
}

interface Gate2Verdict {
  lessonId: string;
  auditedAt: string;
  verdict: "APPROVED" | "REJECTED";
  frames_revisados: number;
  problemas: Gate2Problema[];
}

interface Gate3Hallazgo {
  tipo: string;
  detalle: string;
  severidad: string;
  lessonId?: string;
}

interface Gate3Verdict {
  moduleId: string;
  auditedAt: string;
  verdict: "APPROVED" | "REJECTED";
  hallazgos: Gate3Hallazgo[];
}

interface PackageManifestLesson {
  lessonId: string;
  moduleId: string;
  fileName: string;
  notasPath: string;
}

interface PackageManifest {
  packagedAt: string;
  courseDir: string;
  lessons: PackageManifestLesson[];
}

interface OverlayBrief {
  key: string;
  fact: string;
  at_seconds: number;
  clip: string;
  prompt: string;
  aspect: string;
}

interface OverlayBriefsFile {
  lessonId: string;
  generatedAt: string;
  briefs: OverlayBrief[];
}

interface Gate1ImageVerdict {
  key: string;
  verdict: "APPROVED" | "REJECTED";
  causa?: string;
  causa_categoria?: string;
  escalar?: boolean;
  escalar_motivo?: string;
}

interface Gate1Verdict {
  auditedAt: string;
  images: Gate1ImageVerdict[];
}

interface OverlayTimelineItem {
  key: string;
  file: string;
  startFrame: number;
  endFrame: number;
  aspect: number;
}

interface OverlayTimelineFile {
  lessonId: string;
  fps: number;
  overlays: OverlayTimelineItem[];
}

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
  /**
   * Candado anti-duplicados (run-lock, ver src/lib/run-lock.ts): nombres de
   * etapa de agente en vuelo para este job ("overlay-briefs", "gate1", etc.)
   * — permite deshabilitar el botón correspondiente y mostrar "Corriendo…"
   * aunque el disparo haya venido de otra pestaña o de antes de recargar la
   * página. Opcional por compatibilidad con respuestas viejas cacheadas.
   */
  running?: string[];
  media: MediaInfo[] | null;
  progress: ProgressJson | null;
  summary: SummaryJson | null;
  manifest: FramesManifest | null;
  structure: StructureJson | null;
  approval: { approvedAt: string } | null;
  audit: AuditJson | null;
  verdicts: Verdict[] | null;
  decisiones: string | null;
  silence: SilenceJson | null;
  cuts: CutsFile[] | null;
  prepProgress: ProgressJson | null;
  assemblyProgress: AssemblyProgressJson | null;
  renders: RenderSidecar[] | null;
  gate2Verdicts?: Record<string, Gate2Verdict | null>;
  gate3Verdicts?: Record<string, Gate3Verdict | null>;
  packageManifest?: PackageManifest | null;
  overlayBriefs?: Record<string, OverlayBriefsFile | null>;
  gate1?: Gate1Verdict | null;
  overlaysTimeline?: Record<string, OverlayTimelineFile | null>;
}

const POLL_INTERVAL_MS = 2000;

/**
 * Los jueces de QA (Gates 1/2/3) son fire-and-forget en el backend y el job
 * queda en un status estable mientras corren, así que el polling general no
 * los recoge: cada disparo abre un polling dedicado con estos parámetros.
 */
const GATE_POLL_INTERVAL_MS = 10_000;
const GATE_POLL_TIMEOUT_MS = 25 * 60 * 1000;
/** gate2-all audita TODAS las clases en secuencia — tope más generoso. */
const GATE2_ALL_POLL_TIMEOUT_MS = 60 * 60 * 1000;

const VERDICT_LABELS: Record<Verdict["verdict"], string> = {
  leccion: "Lección",
  broll: "B-roll",
  descartar: "Descartar",
  otro_curso: "Otro curso",
};

const VERDICT_BADGE_CLASS: Record<Verdict["verdict"], string> = {
  leccion: "verdict-badge verdict-badge--leccion",
  broll: "verdict-badge verdict-badge--broll",
  descartar: "verdict-badge verdict-badge--descartar",
  otro_curso: "verdict-badge verdict-badge--otro-curso",
};

/**
 * Estatus del job que implican que el paso 2 (transcripción/muestreo) ya
 * quedó atrás y hay etapas posteriores con artefactos derivados (estructura,
 * aprobación, preparación, ensamblaje). Re-transcribir o re-muestrear frames
 * en estos casos regresa el job a 'sampled' vía runPipeline y deja esos
 * artefactos huérfanos, así que requieren confirmación explícita.
 */
const BEYOND_SAMPLED_STATUSES: JobJson["status"][] = [
  "planning",
  "planned",
  "preparing",
  "prepared",
  "assembling",
  "assembled",
];

/** Etiqueta corta del status crudo del job (se muestra bajo el título). */
const STATUS_LABELS: Record<JobJson["status"], string> = {
  ingested: "Material ingerido",
  probing: "Midiendo videos",
  probed: "Videos medidos",
  transcribing: "Transcribiendo",
  transcribed: "Transcripción lista",
  sampling: "Muestreando frames",
  sampled: "Listo para estructurar",
  planning: "Generando estructura",
  planned: "Estructura generada",
  preparing: "Preparando corte",
  prepared: "Corte preparado",
  assembling: "Ensamblando clases",
  assembled: "Clases ensambladas",
  error: "Error",
};

/** A qué paso del wizard pertenece cada etapa de job.stages. */
const STAGE_TO_STEP: Record<string, number> = {
  probe: 2,
  transcribe: 2,
  frames: 2,
  plan: 3,
  silence: 4,
  proxies: 4,
  cuts: 4,
  captions: 4,
  intros: 6,
  assembly: 6,
};

export default function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();

  const [data, setData] = useState<JobApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Reloj para los contadores de tiempo transcurrido de etapas en curso.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /* ---------------- estado por acción (mismos patrones que v1) --------- */
  const [retranscribing, setRetranscribing] = useState(false);
  const [retranscribeError, setRetranscribeError] = useState<string | null>(null);
  const [sampling, setSampling] = useState(false);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [assembling, setAssembling] = useState(false);
  const [assembleError, setAssembleError] = useState<string | null>(null);

  const [gate2Loading, setGate2Loading] = useState<string | null>(null);
  const [gate2Errors, setGate2Errors] = useState<Record<string, string>>({});
  const [gate2AllRunning, setGate2AllRunning] = useState(false);
  const [gate2AllError, setGate2AllError] = useState<string | null>(null);

  const [gate3Loading, setGate3Loading] = useState<string | null>(null);
  const [gate3Errors, setGate3Errors] = useState<Record<string, string>>({});

  const [packaging, setPackaging] = useState(false);
  const [packageError, setPackageError] = useState<string | null>(null);

  const [runningAll, setRunningAll] = useState(false);
  const [runAllError, setRunAllError] = useState<string | null>(null);

  const [generatingBriefs, setGeneratingBriefs] = useState(false);
  const [overlayBriefsError, setOverlayBriefsError] = useState<string | null>(null);
  const [generatingOverlayImages, setGeneratingOverlayImages] = useState(false);
  const [overlayGenError, setOverlayGenError] = useState<string | null>(null);
  const [gate1Loading, setGate1Loading] = useState(false);
  const [gate1Error, setGate1Error] = useState<string | null>(null);
  const [recalculatingTimeline, setRecalculatingTimeline] = useState(false);
  const [overlaysTimelineError, setOverlaysTimelineError] = useState<string | null>(null);

  // Auditoría de subtítulos (etapa 12, fire-and-forget sin veredicto en la
  // respuesta del GET): solo se confirma el disparo.
  const [auditingCaptions, setAuditingCaptions] = useState(false);
  const [auditCaptionsError, setAuditCaptionsError] = useState<string | null>(null);
  const [auditCaptionsNotice, setAuditCaptionsNotice] = useState(false);

  const [showMaster, setShowMaster] = useState(false);
  const [masterText, setMasterText] = useState<string | null>(null);
  const [masterLoading, setMasterLoading] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);

  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [editingStructure, setEditingStructure] = useState(false);
  const [editStructure, setEditStructure] = useState<StructureJson | null>(null);
  const [structureJsonText, setStructureJsonText] = useState("");
  const [structureJsonError, setStructureJsonError] = useState<string | null>(null);
  const [savingStructure, setSavingStructure] = useState(false);
  const [saveStructureError, setSaveStructureError] = useState<string | null>(null);
  const [structureSavedNotice, setStructureSavedNotice] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---------------- carga + polling general (cada 2 s) ----------------- */

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
   * Ciclo de polling: consulta el job y, si está en un estado transitorio,
   * re-programa la consulta 2 s después. Los estados estables (sampled,
   * planned, prepared, assembled, error, o 'transcribed' sin manifest) NO
   * siguen polleando — cada botón que dispara una etapa reanuda el ciclo.
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

  /* ---------------- pollings dedicados de los gates -------------------- */

  const gatePollTimersRef = useRef<
    Record<
      string,
      {
        intervalId: ReturnType<typeof setInterval>;
        timeoutId: ReturnType<typeof setTimeout>;
      }
    >
  >({});

  const stopGatePolling = useCallback((key: string) => {
    const timers = gatePollTimersRef.current[key];
    if (timers) {
      clearInterval(timers.intervalId);
      clearTimeout(timers.timeoutId);
      delete gatePollTimersRef.current[key];
    }
  }, []);

  useEffect(() => {
    const timersRef = gatePollTimersRef;
    return () => {
      Object.values(timersRef.current).forEach((timers) => {
        clearInterval(timers.intervalId);
        clearTimeout(timers.timeoutId);
      });
      timersRef.current = {};
    };
  }, []);

  /**
   * Abre un polling dedicado (cada GATE_POLL_INTERVAL_MS) que refetchea el
   * job hasta que `isDone(body)` sea true o venza `timeoutMs`. Un solo
   * mecanismo para Gates 1/2/3 y gate2-all.
   */
  const startGatePolling = useCallback(
    (
      key: string,
      isDone: (body: JobApiResponse | null) => boolean,
      timeoutMs: number,
      onStop?: () => void
    ) => {
      stopGatePolling(key);
      const intervalId = setInterval(async () => {
        const body = await loadJob();
        if (isDone(body)) {
          stopGatePolling(key);
          onStop?.();
        }
      }, GATE_POLL_INTERVAL_MS);
      const timeoutId = setTimeout(() => {
        stopGatePolling(key);
        onStop?.();
      }, timeoutMs);
      gatePollTimersRef.current[key] = { intervalId, timeoutId };
    },
    [loadJob, stopGatePolling]
  );

  /* ---------------- acciones por etapa --------------------------------- */

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
      startPolling();
    } catch {
      setRetranscribeError("No se pudo iniciar la re-transcripción.");
    } finally {
      setRetranscribing(false);
    }
  }, [jobId, startPolling]);

  const handleSample = useCallback(async () => {
    setSampleError(null);
    setSampling(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/frames`, { method: "POST" });
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
      startPolling();
    } catch {
      setSampleError("No se pudo iniciar el muestreo de frames.");
    } finally {
      setSampling(false);
    }
  }, [jobId, startPolling]);

  const handlePlan = useCallback(async () => {
    setPlanError(null);
    setPlanning(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/plan`, { method: "POST" });
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
      startPolling();
    } catch {
      setPlanError("No se pudo iniciar la generación de la estructura.");
    } finally {
      setPlanning(false);
    }
  }, [jobId, startPolling]);

  const handleApprove = useCallback(async () => {
    setApproveError(null);
    setApproving(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/approve`, { method: "POST" });
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

  /* -------- edición de estructura (gate humano) ------------------------ */

  const handleStartEdit = useCallback((structure: StructureJson) => {
    const clone: StructureJson = JSON.parse(JSON.stringify(structure));
    setEditStructure(clone);
    setStructureJsonText(JSON.stringify(clone, null, 2));
    setStructureJsonError(null);
    setSaveStructureError(null);
    setStructureSavedNotice(false);
    setEditingStructure(true);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingStructure(false);
    setEditStructure(null);
    setStructureJsonText("");
    setStructureJsonError(null);
    setSaveStructureError(null);
  }, []);

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

  const handleApplyStructureJson = useCallback(() => {
    try {
      const parsed = JSON.parse(structureJsonText) as StructureJson;
      setEditStructure(parsed);
      setStructureJsonError(null);
    } catch {
      setStructureJsonError("JSON inválido: revisá la sintaxis.");
    }
  }, [structureJsonText]);

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
        setSaveStructureError(body?.error ?? "No se pudo guardar la estructura.");
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

  /* -------- preparación / ensamblaje ----------------------------------- */

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
          setPrepError(body?.error ?? "El proyecto todavía no puede prepararse.");
          return;
        }
        if (!res.ok) {
          setPrepError("No se pudo iniciar la preparación del corte.");
          return;
        }
        startPolling();
      } catch {
        setPrepError("No se pudo iniciar la preparación del corte.");
      } finally {
        setPreparing(false);
      }
    },
    [jobId, startPolling]
  );

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
        startPolling();
      } catch {
        setAssembleError("No se pudo iniciar el ensamblaje.");
      } finally {
        setAssembling(false);
      }
    },
    [jobId, startPolling]
  );

  /* -------- auditoría de subtítulos (etapa 12) ------------------------- */

  const handleAuditCaptions = useCallback(async () => {
    setAuditCaptionsError(null);
    setAuditCaptionsNotice(false);
    setAuditingCaptions(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/audit-captions`, {
        method: "POST",
      });
      if (res.status === 409) {
        // Benigno: ya hay una auditoría en vuelo (candado run-lock), no un
        // error. `running` en el próximo poll refleja el estado real.
        setAuditCaptionsNotice(true);
        await loadJob();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setAuditCaptionsError(
          body?.error ?? "No se pudo disparar la auditoría de subtítulos."
        );
        return;
      }
      setAuditCaptionsNotice(true);
    } catch {
      setAuditCaptionsError("No se pudo disparar la auditoría de subtítulos.");
    } finally {
      setAuditingCaptions(false);
    }
  }, [jobId, loadJob]);

  /* -------- gates de QA ------------------------------------------------ */

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
        if (res.status === 409) {
          // Benigno: Gate 2 ya está corriendo (candado run-lock) para este
          // job, no un error. `running` en el próximo poll refleja el chip.
          await loadJob();
          return;
        }
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
        startGatePolling(
          `gate2:${lessonId}`,
          (next) =>
            JSON.stringify(next?.gate2Verdicts?.[lessonId] ?? null) !==
            previousVerdict,
          GATE_POLL_TIMEOUT_MS
        );
      } catch {
        setGate2Errors((prev) => ({
          ...prev,
          [lessonId]: "No se pudo correr el QA visual.",
        }));
      } finally {
        setGate2Loading(null);
      }
    },
    [jobId, loadJob, startGatePolling]
  );

  /**
   * Gate 2 sobre TODAS las clases renderizadas (POST /gate2-all): el
   * backend audita en secuencia/pool y va dejando qa/gate2/<lessonId>.json.
   * El polling dedicado termina cuando todos los renders tienen un veredicto
   * más nuevo que el disparo (o al vencer el tope).
   */
  const handleGate2All = useCallback(async () => {
    setGate2AllError(null);
    setGate2AllRunning(true);
    const startedAt = Date.now();
    try {
      const res = await fetch(`/api/jobs/${jobId}/gate2-all`, {
        method: "POST",
      });
      if (res.status === 409) {
        // Benigno: gate2-all ya está corriendo (candado run-lock) para este
        // job, no un error. El chip "Corriendo…" refleja `running`.
        await loadJob();
        setGate2AllRunning(false);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setGate2AllError(
          body?.error ?? "No se pudo correr el QA de todas las clases."
        );
        setGate2AllRunning(false);
        return;
      }
      await loadJob();
      startGatePolling(
        "gate2-all",
        (body) => {
          const rendersNow = body?.renders ?? [];
          if (rendersNow.length === 0) return false;
          const fresh = rendersNow.filter((r) => {
            const v = body?.gate2Verdicts?.[r.lessonId];
            return v && new Date(v.auditedAt).getTime() >= startedAt - 60_000;
          });
          return fresh.length >= rendersNow.length;
        },
        GATE2_ALL_POLL_TIMEOUT_MS,
        () => setGate2AllRunning(false)
      );
    } catch {
      setGate2AllError("No se pudo correr el QA de todas las clases.");
      setGate2AllRunning(false);
    }
  }, [jobId, loadJob, startGatePolling]);

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
        if (res.status === 409) {
          // Benigno: Gate 3 ya está corriendo (candado run-lock) para este
          // job, no un error. `running` en el próximo poll refleja el chip.
          await loadJob();
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setGate3Errors((prev) => ({
            ...prev,
            [moduleId]:
              body?.error ?? "No se pudo correr la revisión de módulo.",
          }));
          return;
        }
        const body = await loadJob();
        const previousVerdict = JSON.stringify(
          body?.gate3Verdicts?.[moduleId] ?? null
        );
        startGatePolling(
          `gate3:${moduleId}`,
          (next) =>
            JSON.stringify(next?.gate3Verdicts?.[moduleId] ?? null) !==
            previousVerdict,
          GATE_POLL_TIMEOUT_MS
        );
      } catch {
        setGate3Errors((prev) => ({
          ...prev,
          [moduleId]: "No se pudo correr la revisión de módulo.",
        }));
      } finally {
        setGate3Loading(null);
      }
    },
    [jobId, loadJob, startGatePolling]
  );

  /* -------- overlays --------------------------------------------------- */

  const handleOverlayBriefs = useCallback(async () => {
    setOverlayBriefsError(null);
    setGeneratingBriefs(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/overlay-briefs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        // Benigno: ya está corriendo (candado run-lock), no un error.
        await loadJob();
        return;
      }
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

  const handleOverlayGen = useCallback(async () => {
    setOverlayGenError(null);
    setGeneratingOverlayImages(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/overlay-gen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        // Benigno: ya está corriendo (candado run-lock), no un error.
        await loadJob();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setOverlayGenError(
          body?.error ?? "No se pudieron generar las imágenes de overlays."
        );
        return;
      }
      await loadJob();
    } catch {
      setOverlayGenError("No se pudieron generar las imágenes de overlays.");
    } finally {
      setGeneratingOverlayImages(false);
    }
  }, [jobId, loadJob]);

  const handleGate1 = useCallback(async () => {
    setGate1Error(null);
    setGate1Loading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/gate1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        // Benigno: Gate 1 ya está corriendo (candado run-lock), no un error.
        await loadJob();
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setGate1Error(body?.error ?? "No se pudo correr el Gate 1.");
        return;
      }
      const body = await loadJob();
      const previousVerdict = JSON.stringify(body?.gate1 ?? null);
      startGatePolling(
        "gate1",
        (next) => JSON.stringify(next?.gate1 ?? null) !== previousVerdict,
        GATE_POLL_TIMEOUT_MS
      );
    } catch {
      setGate1Error("No se pudo correr el Gate 1.");
    } finally {
      setGate1Loading(false);
    }
  }, [jobId, loadJob, startGatePolling]);

  const handleOverlaysTimeline = useCallback(async () => {
    setOverlaysTimelineError(null);
    setRecalculatingTimeline(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/overlays-timeline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setOverlaysTimelineError(
          body?.error ?? "No se pudo recalcular el timeline de overlays."
        );
        return;
      }
      await loadJob();
    } catch {
      setOverlaysTimelineError("No se pudo recalcular el timeline de overlays.");
    } finally {
      setRecalculatingTimeline(false);
    }
  }, [jobId, loadJob]);

  /* -------- entrega / modo experto ------------------------------------- */

  const handlePackage = useCallback(async () => {
    setPackageError(null);
    setPackaging(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/package`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        // Benigno: el empaquetado ya está corriendo (candado run-lock), no
        // un error.
        await loadJob();
        return;
      }
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

  const handleRunAll = useCallback(async () => {
    setRunAllError(null);
    setRunningAll(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/run-all`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setRunAllError(body?.error ?? "No se pudo iniciar la corrida completa.");
        return;
      }
      await loadJob();
      startPolling();
    } catch {
      setRunAllError("No se pudo iniciar la corrida completa.");
    } finally {
      setRunningAll(false);
    }
  }, [jobId, loadJob, startPolling]);

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

  /* ---------------- render --------------------------------------------- */

  if (loading) {
    return (
      <main className="container">
        <h1>
          <span className="spinner spinner-inline" /> Cargando proyecto…
        </h1>
      </main>
    );
  }

  if (notFound || !data) {
    return (
      <main className="container">
        <h1>Proyecto no encontrado</h1>
        <p>
          <Link href="/">← Volver al inicio</Link>
        </p>
      </main>
    );
  }

  const {
    job,
    running,
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
    gate1,
    overlaysTimeline,
  } = data;

  const isError = job.status === "error";
  const stages: NonNullable<JobJson["stages"]> = job.stages ?? {};

  /**
   * Candado anti-duplicados (run-lock): true si el backend reporta la etapa
   * `stage` como en vuelo (GET /api/jobs/[jobId] -> running[]). Se usa para
   * deshabilitar el botón correspondiente y mostrar "Corriendo…" incluso si
   * el disparo vino de otra pestaña/sesión, o si la página se recargó
   * después de haber disparado la etapa (el estado local del handler solo
   * cubre el fetch en sí, que es fire-and-forget y responde casi de
   * inmediato).
   */
  const isRunning = (stage: string): boolean => (running ?? []).includes(stage);

  // ¿En qué etapa (de job.stages) quedó colgado el error? La que arrancó y
  // no terminó. Determina en qué PASO del wizard pintar el error.
  let failedStageKey: string | null = null;
  if (isError) {
    for (const [key, timing] of Object.entries(stages)) {
      if (timing?.startedAt && !timing.finishedAt) {
        failedStageKey = key;
        break;
      }
    }
  }
  const failedStep = failedStageKey ? STAGE_TO_STEP[failedStageKey] ?? null : null;

  const canRetryPlanOnly = isError && manifest !== null;
  const canRetryPrepOnly = isError && structure !== null;

  /* ---- progreso / datos derivados (idénticos a v1) ---- */
  const progressFiles = progress?.files ?? {};
  const totalFiles = job.files.length;
  const doneFiles = Object.values(progressFiles).filter(
    (f) => f.status === "done" || f.status === "error"
  ).length;

  const prepFiles = prepProgress?.files ?? {};
  const prepTotalFiles = Object.keys(prepFiles).length;
  const prepDoneFiles = Object.values(prepFiles).filter(
    (f) => f.status === "done" || f.status === "error"
  ).length;

  const assemblyLessons = Object.entries(assemblyProgress?.lessons ?? {});
  const assemblyTotal = assemblyProgress?.total ?? 0;
  const assemblyDone = assemblyLessons.filter(
    ([, l]) =>
      l.status === "done" || l.status === "skipped" || l.status === "error"
  ).length;

  const completedRenders = renders ?? [];
  const rendersByLesson = new Map(completedRenders.map((r) => [r.lessonId, r]));
  const canPackage = completedRenders.length > 0;

  const lessonTitles = new Map<string, string>();
  const allLessonIds: string[] = [];
  for (const module of structure?.modules ?? []) {
    for (const lesson of module.lessons) {
      lessonTitles.set(lesson.id, lesson.title);
      allLessonIds.push(lesson.id);
    }
  }

  const totalDuration = media
    ? media.reduce((acc, m) => acc + m.durationSeconds, 0)
    : job.files.reduce((acc, f) => acc + f.durationSeconds, 0);

  const brollFiles = summary?.files.filter((f) => !f.narration) ?? [];

  const briefsEntries = Object.entries(overlayBriefs ?? {}).filter(
    ([, f]) => f !== null
  );
  const timelineEntries = Object.entries(overlaysTimeline ?? {}).filter(
    ([, f]) => f !== null
  );
  const gate1Rejected = gate1?.images.filter((i) => i.verdict === "REJECTED") ?? [];

  const gate2Done = completedRenders.filter(
    (r) => (gate2Verdicts?.[r.lessonId] ?? null) !== null
  );
  const gate2Rejected = completedRenders.filter(
    (r) => gate2Verdicts?.[r.lessonId]?.verdict === "REJECTED"
  );
  const modules = structure?.modules ?? [];
  const gate3Done = modules.filter((m) => (gate3Verdicts?.[m.id] ?? null) !== null);
  const gate3Rejected = modules.filter(
    (m) => gate3Verdicts?.[m.id]?.verdict === "REJECTED"
  );

  /* ---- estado de cada paso del wizard ---- */

  // Paso 2 — Transcripción (probe + whisper + frames)
  const transcribeRunning =
    job.status === "probing" ||
    job.status === "transcribing" ||
    job.status === "sampling";
  const transcribeDone = manifest !== null;
  const step2: StepState =
    isError && failedStep === 2
      ? "error"
      : transcribeRunning
        ? "corriendo"
        : transcribeDone
          ? "listo"
          : "pendiente";

  // Paso 3 — Estructura (agente + gate humano)
  const step3: StepState =
    isError && failedStep === 3
      ? "error"
      : job.status === "planning"
        ? "corriendo"
        : structure && approval
          ? "listo"
          : structure
            ? "atencion"
            : transcribeDone
              ? "pendiente"
              : "bloqueado";

  // Paso 4 — Preparación (5A/5B/5C + captions)
  const step4: StepState =
    isError && failedStep === 4
      ? "error"
      : job.status === "preparing"
        ? "corriendo"
        : cuts !== null
          ? "listo"
          : structure && approval
            ? "pendiente"
            : "bloqueado";

  // Paso 5 — Overlays (briefs → imágenes → Gate 1 → timeline)
  const overlaysBusy =
    generatingBriefs ||
    generatingOverlayImages ||
    gate1Loading ||
    recalculatingTimeline ||
    Boolean(gatePollTimersRef.current["gate1"]);
  const step5: StepState =
    cuts === null
      ? "bloqueado"
      : overlaysBusy
        ? "corriendo"
        : timelineEntries.length > 0
          ? gate1Rejected.length > 0
            ? "atencion"
            : "listo"
          : "pendiente";

  // Paso 6 — Ensamblaje
  const step6: StepState =
    isError && failedStep === 6
      ? "error"
      : job.status === "assembling"
        ? "corriendo"
        : completedRenders.length > 0 &&
            allLessonIds.length > 0 &&
            allLessonIds.every((id) => rendersByLesson.has(id))
          ? "listo"
          : cuts !== null
            ? "pendiente"
            : "bloqueado";

  // Paso 7 — QA (Gates 2 y 3)
  const gate7Running =
    gate2AllRunning ||
    gate2Loading !== null ||
    gate3Loading !== null ||
    Object.keys(gatePollTimersRef.current).some(
      (k) => k.startsWith("gate2") || k.startsWith("gate3")
    );
  const step7: StepState =
    completedRenders.length === 0
      ? "bloqueado"
      : gate7Running
        ? "corriendo"
        : gate2Rejected.length > 0 || gate3Rejected.length > 0
          ? "atencion"
          : gate2Done.length === completedRenders.length &&
              modules.length > 0 &&
              gate3Done.length === modules.length
            ? "listo"
            : "pendiente";

  // Paso 8 — Entrega
  const step8: StepState = packageManifest
    ? "listo"
    : packaging
      ? "corriendo"
      : canPackage
        ? "pendiente"
        : "bloqueado";

  /* ---- tiempos por paso (chips ⏱) ---- */
  const t2 = formatElapsed(
    sumElapsed([stages.probe, stages.transcribe, stages.frames], nowMs)
  );
  const t3 = formatElapsed(elapsedOf(stages.plan, nowMs));
  const t4 = formatElapsed(
    sumElapsed(
      [stages.silence, stages.proxies, stages.cuts, stages.captions],
      nowMs
    )
  );
  const t6 = formatElapsed(sumElapsed([stages.intros, stages.assembly], nowMs));

  return (
    <main className="container">
      <div className="job-head">
        <h1>{job.name}</h1>
        <span
          className={`badge ${isError ? "badge-error" : job.status === "assembled" ? "" : "badge-neutral"}`}
        >
          {STATUS_LABELS[job.status]}
        </span>
      </div>
      <p className="job-head-sub">
        {job.files.length} videos · {formatDuration(totalDuration)} de material
        crudo · creado {new Date(job.createdAt).toLocaleString()}
      </p>

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
                  : "Reintentar estructura (sin re-transcribir)"}
              </button>
            )}
            {canRetryPrepOnly && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handlePrep()}
                disabled={preparing}
              >
                {preparing
                  ? "Reintentando preparación…"
                  : "Reintentar preparación"}
              </button>
            )}
            <button
              className="btn"
              type="button"
              onClick={handleRetranscribe}
              disabled={retranscribing}
            >
              {retranscribing ? "Reintentando…" : "Reintentar pipeline completo"}
            </button>
          </div>
          {planError && <p className="stepper-error-msg">{planError}</p>}
          {prepError && <p className="stepper-error-msg">{prepError}</p>}
          {retranscribeError && (
            <p className="stepper-error-msg">{retranscribeError}</p>
          )}
        </div>
      )}

      <ol className="wz">
        {/* ============ PASO 1 — SUBIR ============ */}
        <StepCard
          index={1}
          title="Subir material"
          state="listo"
          desc="El ZIP ya fue recibido, descomprimido y analizado. Los originales no se tocan."
        >
          <div>
            {job.files.map((f) => (
              <div className="row" key={f.filename}>
                <span>{f.filename}</span>
                <span>
                  {formatDuration(f.durationSeconds)}
                  {f.issues.includes("no_audio") && (
                    <span className="badge badge-warning"> sin audio</span>
                  )}
                  {f.issues.includes("not_a_video") && (
                    <span className="badge badge-error"> no es video</span>
                  )}
                  {f.issues.includes("zero_duration") && (
                    <span className="badge badge-error"> duración 0</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </StepCard>

        {/* ============ PASO 2 — TRANSCRIPCIÓN ============ */}
        <StepCard
          index={2}
          title="Transcripción"
          state={step2}
          elapsed={t2}
          progress={
            job.status === "transcribing"
              ? {
                  done: doneFiles,
                  total: totalFiles,
                  label: `Transcribiendo ${doneFiles}/${totalFiles} clips`,
                }
              : null
          }
          desc="Medición técnica de cada clip, transcripción con Whisper y muestreo de frames de referencia. Corre sola al subir el ZIP."
        >
          <div>
            <div className="substage">
              <span className="substage-icon">
                {job.status === "probing" ? (
                  <span className="spinner" />
                ) : stages.probe?.finishedAt || media ? (
                  "✓"
                ) : (
                  "•"
                )}
              </span>
              <span className="substage-name">Medición (ffprobe)</span>
              <span className="substage-meta">
                {formatElapsed(elapsedOf(stages.probe, nowMs)) ?? "—"}
              </span>
            </div>
            <div className="substage">
              <span className="substage-icon">
                {job.status === "transcribing" ? (
                  <span className="spinner" />
                ) : stages.transcribe?.finishedAt || summary ? (
                  "✓"
                ) : (
                  "•"
                )}
              </span>
              <span className="substage-name">Transcripción</span>
              <span className="substage-meta">
                {job.status === "transcribing"
                  ? `${doneFiles}/${totalFiles} clips`
                  : (formatElapsed(elapsedOf(stages.transcribe, nowMs)) ?? "—")}
              </span>
            </div>
            <div className="substage">
              <span className="substage-icon">
                {job.status === "sampling" ? (
                  <span className="spinner" />
                ) : manifest ? (
                  "✓"
                ) : (
                  "•"
                )}
              </span>
              <span className="substage-name">Frames de referencia</span>
              <span className="substage-meta">
                {formatElapsed(elapsedOf(stages.frames, nowMs)) ?? "—"}
              </span>
            </div>
          </div>

          {job.status === "transcribing" && (
            <div style={{ marginTop: "0.75rem" }}>
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
                          <span className="spinner spinner-inline" />
                          transcribiendo
                        </>
                      )}
                      {status === "done" && "✓"}
                      {status === "error" && (
                        <span className="badge badge-error">
                          error
                          {fileProgress?.error ? `: ${fileProgress.error}` : ""}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {brollFiles.length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              {brollFiles.map((f) => (
                <div className="row" key={f.filename}>
                  <span>{f.filename}</span>
                  <span className="badge">B-roll / sin narración</span>
                </div>
              ))}
            </div>
          )}

          {transcribeDone && (
            <>
              <div className="stepper-actions">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={handleToggleMaster}
                >
                  {showMaster
                    ? "Ocultar transcripción completa"
                    : "Ver transcripción completa"}
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    if (
                      !BEYOND_SAMPLED_STATUSES.includes(job.status) ||
                      window.confirm(
                        "Este proyecto ya avanzó más allá de la transcripción (estructura, preparación y/o ensamblaje). Re-transcribir lo regresa a 'listo para estructurar' y esas etapas posteriores quedarán invalidadas/huérfanas. ¿Continuar?"
                      )
                    ) {
                      handleRetranscribe();
                    }
                  }}
                  disabled={retranscribing}
                >
                  {retranscribing ? "Re-transcribiendo…" : "Re-transcribir"}
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    if (
                      !BEYOND_SAMPLED_STATUSES.includes(job.status) ||
                      window.confirm(
                        "Este proyecto ya avanzó más allá de la transcripción (estructura, preparación y/o ensamblaje). Re-muestrear frames lo regresa a 'listo para estructurar' y esas etapas posteriores quedarán invalidadas/huérfanas. ¿Continuar?"
                      )
                    ) {
                      handleSample();
                    }
                  }}
                  disabled={sampling}
                >
                  {sampling ? "Muestreando…" : "Re-muestrear frames"}
                </button>
              </div>
              {retranscribeError && (
                <p className="stepper-error-msg">{retranscribeError}</p>
              )}
              {sampleError && <p className="stepper-error-msg">{sampleError}</p>}
              {showMaster && (
                <div>
                  {masterLoading && <p>Cargando master.txt…</p>}
                  {masterError && (
                    <p className="stepper-error-msg">{masterError}</p>
                  )}
                  {masterText !== null && !masterLoading && (
                    <pre className="master-pre">{masterText}</pre>
                  )}
                </div>
              )}
            </>
          )}

          {/* Compat jobs viejos: 'transcribed' sin manifest — disparo manual */}
          {job.status === "transcribed" && manifest === null && (
            <div className="stepper-actions">
              <button
                className="btn"
                type="button"
                onClick={handleSample}
                disabled={sampling}
              >
                {sampling ? "Muestreando…" : "Muestrear frames"}
              </button>
            </div>
          )}

          {manifest && manifest.clips.length > 0 && (
            <details className="clip-details">
              <summary className="clip-summary">
                Frames por clip ({manifest.clips.length} clips)
              </summary>
              {manifest.clips.map((clip) => (
                <details className="clip-details" key={clip.filename}>
                  <summary className="clip-summary">
                    <span>{clip.filename}</span>
                    {!clip.narration && <span className="badge">B-roll</span>}
                    <span className="badge badge-neutral">
                      {clip.frames.length} frames
                    </span>
                  </summary>
                  <div className="frames-grid">
                    {clip.frames.map((frame) => (
                      <figure className="frame-thumb" key={frame.file}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
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
            </details>
          )}
        </StepCard>

        {/* ============ PASO 3 — ESTRUCTURA (GATE HUMANO) ============ */}
        <StepCard
          index={3}
          title="Estructura del curso"
          state={step3}
          elapsed={t3}
          desc="El agente editorial propone módulos y clases a partir de la transcripción. Tu aprobación es la puerta para poder cortar."
          lockedHint="Se habilita cuando la transcripción y el muestreo de frames terminen."
        >
          {!structure && (
            <div className="stepper-actions">
              <button
                className="btn"
                type="button"
                onClick={handlePlan}
                disabled={planning || job.status !== "sampled"}
              >
                {planning || job.status === "planning"
                  ? "Generando estructura…"
                  : "Generar estructura (agente)"}
              </button>
            </div>
          )}
          {planError && <p className="stepper-error-msg">{planError}</p>}

          {structure && (
            <>
              <div className="stepper-actions">
                {approval ? (
                  <span className="badge">
                    ✓ Aprobada{" "}
                    {new Date(approval.approvedAt).toLocaleString()}
                  </span>
                ) : (
                  <span className="badge badge-warning">
                    Pendiente de tu aprobación
                  </span>
                )}
                {approval === null && !editingStructure && (
                  <button
                    className="btn"
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
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={handlePlan}
                  disabled={planning}
                >
                  {planning ? "Re-generando…" : "Re-generar estructura"}
                </button>
              </div>
              {approveError && (
                <p className="stepper-error-msg">{approveError}</p>
              )}
              {structureSavedNotice && !editingStructure && (
                <p className="notice-ok">
                  La estructura se guardó: la aprobación quedó pendiente de
                  nuevo.
                </p>
              )}

              <h3>{structure.courseTitle}</h3>

              {editingStructure && editStructure ? (
                <StructureEditor
                  value={editStructure}
                  jsonText={structureJsonText}
                  jsonError={structureJsonError}
                  saving={savingStructure}
                  saveError={saveStructureError}
                  onModuleTitleChange={handleModuleTitleChange}
                  onLessonTitleChange={handleLessonTitleChange}
                  onReorderLesson={handleReorderLesson}
                  onMoveLessonToModule={handleMoveLessonToModule}
                  onJsonTextChange={setStructureJsonText}
                  onApplyJson={handleApplyStructureJson}
                  onSave={handleSaveStructure}
                  onCancel={handleCancelEdit}
                />
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
                              <li className="structure-lesson" key={lesson.id}>
                                <span className="structure-lesson-title">
                                  {lesson.title}
                                </span>
                                <ul className="structure-segment-list">
                                  {lesson.segments.map((seg, idx) => (
                                    <li
                                      className="structure-segment"
                                      key={`${seg.clip}-${idx}`}
                                    >
                                      <span className="badge">{seg.clip}</span>{" "}
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
                <details className="decisiones-details">
                  <summary>
                    Auditoría del agente por clip ({audit.clips.length})
                  </summary>
                  <div className="clip-cards">
                    {audit.clips
                      .slice()
                      .sort((a, b) => {
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
                                className={
                                  VERDICT_BADGE_CLASS[clipAudit.verdict]
                                }
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
                              Confianza:{" "}
                              {Math.round(clipAudit.confianza * 100)}%
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
                                      (
                                      {VERDICT_LABELS[clipAudit.verdictAntes]} →{" "}
                                      {VERDICT_LABELS[clipAudit.verdictDespues]}
                                      )
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
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
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
                </details>
              )}

              {structure.apartados.length > 0 && (
                <details className="decisiones-details">
                  <summary>
                    Apartados — descartes y otro curso (
                    {structure.apartados.length})
                  </summary>
                  <div style={{ marginTop: "0.5rem" }}>
                    {structure.apartados.map((v) => (
                      <div className="row apartado-row" key={v.clip}>
                        <span>
                          <span className="badge">{v.clip}</span>{" "}
                          <span className={VERDICT_BADGE_CLASS[v.verdict]}>
                            {VERDICT_LABELS[v.verdict]}
                          </span>
                          {v.curso && (
                            <span className="badge badge-neutral">
                              curso: {v.curso}
                            </span>
                          )}
                        </span>
                        <span className="apartado-razon">{v.razon}</span>
                      </div>
                    ))}
                  </div>
                </details>
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
            </>
          )}
        </StepCard>

        {/* ============ PASO 4 — PREPARACIÓN ============ */}
        <StepCard
          index={4}
          title="Preparación del corte"
          state={step4}
          elapsed={t4}
          progress={
            job.status === "preparing" && prepTotalFiles > 0
              ? {
                  done: prepDoneFiles,
                  total: prepTotalFiles,
                  label: `Proxies ${prepDoneFiles}/${prepTotalFiles}`,
                }
              : null
          }
          desc="Etapas deterministas: silencio medido por clip, proxies de edición, cortes propuestos y subtítulos remapeados."
          lockedHint="Se habilita cuando apruebes la estructura del curso (paso 3)."
        >
          <div className="stepper-actions">
            <button
              className="btn"
              type="button"
              onClick={() => handlePrep()}
              disabled={preparing || job.status === "preparing" || !approval}
            >
              {preparing || job.status === "preparing"
                ? "Preparando…"
                : cuts !== null
                  ? "Re-preparar corte"
                  : "Preparar corte"}
            </button>
            {approval === null && structure !== null && (
              <button
                className="btn btn-ghost"
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
                disabled={preparing || job.status === "preparing"}
              >
                Preparar sin aprobar
              </button>
            )}
          </div>
          {prepError && <p className="stepper-error-msg">{prepError}</p>}

          {silence && silence.clips.length > 0 && (
            <details className="decisiones-details" open={cuts === null}>
              <summary>Silencio por clip ({silence.clips.length})</summary>
              <table className="table" style={{ marginTop: "0.5rem" }}>
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
                          <span
                            className="badge badge-neutral"
                            title="Demo: sin recorte de silencio interno"
                          >
                            {" "}
                            demo sin recorte
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
            </details>
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
                      <span className="badge badge-neutral">
                        {totalCuts} cortes
                      </span>
                      <span className="badge badge-neutral">
                        {formatTimestamp(rawSeconds)} →{" "}
                        {formatTimestamp(projectedSeconds)}
                      </span>
                    </div>
                    <details className="cuts-details">
                      <summary>Ver cortes por clip</summary>
                      {cutsFile.clips.map((clip, clipIdx) => (
                        <div className="cuts-clip" key={`${clip.clip}-${clipIdx}`}>
                          <p className="cuts-clip-title">
                            <span className="badge">{clip.clip}</span>{" "}
                            {clip.kind === "demo" && (
                              <span className="badge badge-neutral">demo</span>
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
                                    <span className="badge"> ✓ silencio</span>
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

          {cuts !== null && (
            <>
              <div className="stepper-actions">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={handleAuditCaptions}
                  disabled={auditingCaptions || isRunning("audit-captions")}
                >
                  {auditingCaptions || isRunning("audit-captions")
                    ? "Corriendo…"
                    : "Auditar subtítulos (IA)"}
                </button>
              </div>
              {auditCaptionsNotice && (
                <p className="notice-ok">
                  Auditoría de subtítulos disparada — corre en segundo plano y
                  corrige la jerga técnica directamente en plan/captions/.
                </p>
              )}
              {auditCaptionsError && (
                <p className="stepper-error-msg">{auditCaptionsError}</p>
              )}
            </>
          )}
        </StepCard>

        {/* ============ PASO 5 — OVERLAYS ============ */}
        <StepCard
          index={5}
          title="Overlays didácticos"
          state={step5}
          desc="Datos y hechos que se sobreimprimen durante la clase: briefs → imágenes → QA visual (Gate 1) → timeline."
          lockedHint="Se habilita cuando la preparación del corte (paso 4) termine."
        >
          <div className="substage">
            <span className="substage-icon">
              {generatingBriefs || isRunning("overlay-briefs") ? (
                <span className="spinner" />
              ) : briefsEntries.length > 0 ? (
                "✓"
              ) : (
                "•"
              )}
            </span>
            <span className="substage-name">1 · Briefs</span>
            <span className="substage-meta">
              {isRunning("overlay-briefs")
                ? "Corriendo…"
                : briefsEntries.length > 0
                  ? `${briefsEntries.reduce(
                      (n, [, f]) => n + (f?.briefs.length ?? 0),
                      0
                    )} briefs en ${briefsEntries.length} clases`
                  : "—"}
            </span>
          </div>
          <div className="substage">
            <span className="substage-icon">
              {generatingOverlayImages || isRunning("overlay-gen") ? (
                <span className="spinner" />
              ) : (
                "•"
              )}
            </span>
            <span className="substage-name">2 · Imágenes</span>
            <span className="substage-meta">
              {isRunning("overlay-gen")
                ? "Corriendo…"
                : "requiere Chrome CDP en el Mac"}
            </span>
          </div>
          <div className="substage">
            <span className="substage-icon">
              {gate1Loading ||
              isRunning("gate1") ||
              gatePollTimersRef.current["gate1"] ? (
                <span className="spinner" />
              ) : gate1 ? (
                gate1Rejected.length > 0 ? (
                  "✗"
                ) : (
                  "✓"
                )
              ) : (
                "•"
              )}
            </span>
            <span className="substage-name">3 · Gate 1 (QA)</span>
            <span className="substage-meta">
              {gate1
                ? `${gate1.images.length - gate1Rejected.length}/${gate1.images.length} aprobadas`
                : "—"}
            </span>
          </div>
          <div className="substage">
            <span className="substage-icon">
              {recalculatingTimeline ? (
                <span className="spinner" />
              ) : timelineEntries.length > 0 ? (
                "✓"
              ) : (
                "•"
              )}
            </span>
            <span className="substage-name">4 · Timeline</span>
            <span className="substage-meta">
              {timelineEntries.length > 0
                ? `${timelineEntries.length} clases remapeadas`
                : "—"}
            </span>
          </div>

          <div className="stepper-actions">
            <button
              className="btn"
              type="button"
              onClick={handleOverlayBriefs}
              disabled={generatingBriefs || isRunning("overlay-briefs") || cuts === null}
            >
              {generatingBriefs || isRunning("overlay-briefs")
                ? "Corriendo…"
                : briefsEntries.length > 0
                  ? "Re-generar briefs"
                  : "Generar briefs"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleOverlayGen}
              disabled={
                generatingOverlayImages ||
                isRunning("overlay-gen") ||
                briefsEntries.length === 0
              }
              title="Requiere Chrome con depuración remota (puerto 9222) ya logueado en este Mac"
            >
              {generatingOverlayImages || isRunning("overlay-gen")
                ? "Corriendo…"
                : "Generar imágenes"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleGate1}
              disabled={gate1Loading || isRunning("gate1") || briefsEntries.length === 0}
            >
              {gate1Loading || isRunning("gate1")
                ? "Corriendo…"
                : "Correr Gate 1"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleOverlaysTimeline}
              disabled={recalculatingTimeline}
            >
              {recalculatingTimeline ? "Recalculando…" : "Recalcular timeline"}
            </button>
          </div>
          {overlayBriefsError && (
            <p className="stepper-error-msg">{overlayBriefsError}</p>
          )}
          {overlayGenError && (
            <p className="stepper-error-msg">{overlayGenError}</p>
          )}
          {gate1Error && <p className="stepper-error-msg">{gate1Error}</p>}
          {overlaysTimelineError && (
            <p className="stepper-error-msg">{overlaysTimelineError}</p>
          )}

          {briefsEntries.map(([lessonId, file]) => (
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

          {gate1 && (
            <details className="decisiones-details" open={gate1Rejected.length > 0}>
              <summary>
                Veredicto Gate 1 —{" "}
                {gate1Rejected.length > 0
                  ? `${gate1Rejected.length} rechazadas`
                  : "todo aprobado"}
              </summary>
              <p className="assembly-card-meta">
                Auditado: {new Date(gate1.auditedAt).toLocaleString()}
              </p>
              <ul className="cuts-list">
                {gate1.images.map((img) => (
                  <li key={img.key}>
                    {img.verdict === "APPROVED" ? "✅" : "❌"} {img.key}
                    {img.causa ? ` — ${img.causa}` : ""}
                    {img.escalar ? " 🔺 escalar" : ""}
                    {img.escalar && img.escalar_motivo
                      ? ` (${img.escalar_motivo})`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {timelineEntries.map(([lessonId, file]) => (
            <details className="cuts-details" key={`timeline-${lessonId}`}>
              <summary>
                Timeline · {lessonTitles.get(lessonId) ?? lessonId} (
                {file?.overlays.length ?? 0} overlay
                {file?.overlays.length === 1 ? "" : "s"})
              </summary>
              <ul className="cuts-list">
                {file?.overlays.map((o) => (
                  <li key={o.key}>
                    {o.key} — frames [{o.startFrame}, {o.endFrame}) — {o.file}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </StepCard>

        {/* ============ PASO 6 — ENSAMBLAJE ============ */}
        <StepCard
          index={6}
          title="Ensamblaje de clases"
          state={step6}
          elapsed={t6}
          progress={
            job.status === "assembling" && assemblyTotal > 0
              ? {
                  done: assemblyDone,
                  total: assemblyTotal,
                  label: `${assemblyDone}/${assemblyTotal} clases ensambladas`,
                }
              : null
          }
          desc={`Intro animada + tramos sin silencio + subtítulos + overlays, en 1080p/30. Solo se listan renders verificados frame a frame.${
            assemblyProgress?.backend
              ? ` Backend: ${assemblyProgress.backend}.`
              : ""
          }`}
          lockedHint="Se habilita cuando la preparación del corte (paso 4) termine."
        >
          <div className="stepper-actions">
            <button
              className="btn"
              type="button"
              onClick={() => handleAssemble(false)}
              disabled={assembling || job.status === "assembling" || cuts === null}
            >
              {assembling || job.status === "assembling"
                ? "Ensamblando…"
                : completedRenders.length > 0
                  ? "Ensamblar (solo lo que cambió)"
                  : "Ensamblar clases"}
            </button>
            {completedRenders.length > 0 && (
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Re-ensamblar TODO ignora los renders existentes y vuelve a renderizar todas las clases. ¿Continuar?"
                    )
                  ) {
                    handleAssemble(true);
                  }
                }}
                disabled={assembling || job.status === "assembling"}
              >
                Re-ensamblar todo
              </button>
            )}
          </div>
          {assembleError && <p className="stepper-error-msg">{assembleError}</p>}

          {(assemblyLessons.length > 0 || completedRenders.length > 0) && (
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
                    error: undefined as string | undefined,
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
                      <span className="assembly-card-id">{lesson.lessonId}</span>
                    </div>

                    {lesson.status === "error" && (
                      <p className="stepper-error-msg">
                        {lesson.error ?? "Falló el ensamblaje de esta clase."}
                      </p>
                    )}

                    {(lesson.status === "intro" ||
                      lesson.status === "assembling" ||
                      lesson.status === "pending") && (
                      <div>
                        <ProgressBar
                          done={lesson.frame ?? 0}
                          total={lesson.totalFrames ?? 0}
                          indeterminate={
                            lesson.status !== "assembling" ||
                            !lesson.totalFrames
                          }
                          label={
                            lesson.status === "intro"
                              ? "Renderizando intro…"
                              : lesson.status === "assembling"
                                ? `Ensamblando… ${pct}%`
                                : "En cola"
                          }
                        />
                      </div>
                    )}

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
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </StepCard>

        {/* ============ PASO 7 — QA (GATES 2 Y 3) ============ */}
        <StepCard
          index={7}
          title="Control de calidad"
          state={step7}
          desc="Gate 2: un juez con visión revisa frames del render final de cada clase. Gate 3: coherencia del módulo completo."
          lockedHint="Se habilita cuando haya clases ensambladas (paso 6)."
        >
          <div className="stepper-actions">
            <button
              className="btn"
              type="button"
              onClick={handleGate2All}
              disabled={
                gate2AllRunning ||
                isRunning("gate2-all") ||
                completedRenders.length === 0
              }
            >
              {gate2AllRunning || isRunning("gate2-all")
                ? "Corriendo…"
                : "QA de todas las clases (Gate 2)"}
            </button>
            {(gate2AllRunning || isRunning("gate2-all")) && (
              <span className="badge badge-neutral">
                {gate2Done.length}/{completedRenders.length} con veredicto
              </span>
            )}
          </div>
          {gate2AllError && <p className="stepper-error-msg">{gate2AllError}</p>}

          {completedRenders.map((render) => {
            const verdict = gate2Verdicts?.[render.lessonId] ?? null;
            // Nota: candado run-lock de gate2 es a nivel de job (no por
            // lección), así que isRunning("gate2") aplica al deshabilitar
            // cualquier fila mientras cualquier gate2 esté en curso.
            const runningLesson =
              gate2Loading === render.lessonId ||
              isRunning("gate2") ||
              Boolean(gatePollTimersRef.current[`gate2:${render.lessonId}`]);
            const error = gate2Errors[render.lessonId];
            return (
              <div className="row qa-lesson-row" key={render.lessonId}>
                <span className="qa-lesson-name">
                  {lessonTitles.get(render.lessonId) ?? render.lessonId}
                </span>
                <span className="qa-lesson-controls">
                  {verdict === null && !runningLesson && (
                    <span className="badge badge-neutral">sin QA</span>
                  )}
                  {runningLesson && (
                    <span className="badge badge-neutral">
                      <span className="spinner spinner-inline" />
                      {gate2Loading === render.lessonId ||
                      Boolean(
                        gatePollTimersRef.current[`gate2:${render.lessonId}`]
                      )
                        ? "juzgando…"
                        : "Corriendo…"}
                    </span>
                  )}
                  {verdict?.verdict === "APPROVED" && (
                    <span className="badge">✅ Aprobada</span>
                  )}
                  {verdict?.verdict === "REJECTED" && (
                    <span className="badge badge-error">
                      ❌ Rechazada ({verdict.problemas.length})
                    </span>
                  )}
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => handleGate2(render.lessonId)}
                    disabled={runningLesson || gate2AllRunning || isRunning("gate2-all")}
                  >
                    {verdict ? "Re-correr QA" : "QA visual"}
                  </button>
                </span>
                {error && (
                  <p className="stepper-error-msg" style={{ flexBasis: "100%" }}>
                    {error}
                  </p>
                )}
                {verdict?.verdict === "REJECTED" &&
                  verdict.problemas.length > 0 && (
                    <details
                      className="cuts-details"
                      style={{ flexBasis: "100%" }}
                    >
                      <summary>Ver problemas detectados</summary>
                      <ul className="cuts-list">
                        {verdict.problemas.map((p, idx) => (
                          <li key={`${p.frame}-${idx}`}>
                            frame {p.frame} — {p.tipo} ({p.severidad}):{" "}
                            {p.detalle}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
              </div>
            );
          })}

          {modules.length > 0 && (
            <>
              <h3 style={{ marginTop: "1.25rem" }}>
                Revisión de módulo (Gate 3)
              </h3>
              {modules.map((module) => {
                const verdict = gate3Verdicts?.[module.id] ?? null;
                // Nota: candado run-lock de gate3 es a nivel de job (no por
                // módulo), así que isRunning("gate3") deshabilita cualquier
                // fila mientras cualquier gate3 esté en curso.
                const runningModule =
                  gate3Loading === module.id ||
                  isRunning("gate3") ||
                  Boolean(gatePollTimersRef.current[`gate3:${module.id}`]);
                const error = gate3Errors[module.id];
                return (
                  <div className="row qa-lesson-row" key={module.id}>
                    <span className="qa-lesson-name">{module.title}</span>
                    <span className="qa-lesson-controls">
                      {verdict === null && !runningModule && (
                        <span className="badge badge-neutral">sin revisión</span>
                      )}
                      {runningModule && (
                        <span className="badge badge-neutral">
                          <span className="spinner spinner-inline" />
                          {gate3Loading === module.id ||
                          Boolean(gatePollTimersRef.current[`gate3:${module.id}`])
                            ? "revisando…"
                            : "Corriendo…"}
                        </span>
                      )}
                      {verdict?.verdict === "APPROVED" && (
                        <span className="badge">✅ Aprobado</span>
                      )}
                      {verdict?.verdict === "REJECTED" && (
                        <span className="badge badge-error">
                          ❌ Rechazado ({verdict.hallazgos.length})
                        </span>
                      )}
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => handleGate3(module.id)}
                        disabled={runningModule}
                      >
                        {verdict ? "Re-revisar" : "Revisar módulo"}
                      </button>
                    </span>
                    {error && (
                      <p
                        className="stepper-error-msg"
                        style={{ flexBasis: "100%" }}
                      >
                        {error}
                      </p>
                    )}
                    {verdict?.verdict === "REJECTED" &&
                      verdict.hallazgos.length > 0 && (
                        <details
                          className="cuts-details"
                          style={{ flexBasis: "100%" }}
                        >
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
            </>
          )}
        </StepCard>

        {/* ============ PASO 8 — ENTREGA ============ */}
        <StepCard
          index={8}
          title="Entrega"
          state={step8}
          desc="Empaqueta el curso completo (renders + notas por clase) en un directorio de entrega auditable."
          lockedHint="Se habilita cuando haya clases ensambladas (paso 6)."
        >
          <div className="stepper-actions">
            <button
              className="btn"
              type="button"
              onClick={handlePackage}
              disabled={!canPackage || packaging || isRunning("package")}
            >
              {packaging || isRunning("package")
                ? "Corriendo…"
                : packageManifest
                  ? "Re-empaquetar curso"
                  : "Empaquetar curso"}
            </button>
            {packageManifest && (
              <Link
                className="btn btn-secondary"
                href={`/jobs/${encodeURIComponent(jobId)}/course`}
              >
                Ver curso completo →
              </Link>
            )}
          </div>
          {packageError && <p className="stepper-error-msg">{packageError}</p>}

          {packageManifest && (
            <div>
              <p className="assembly-card-meta">
                {packageManifest.courseDir} · empaquetado{" "}
                {new Date(packageManifest.packagedAt).toLocaleString()}
              </p>
              <ul className="cuts-list">
                {packageManifest.lessons.map((l) => (
                  <li key={l.lessonId}>
                    {l.moduleId} / {l.lessonId} — {l.fileName}{" "}
                    <a
                      href={`/api/jobs/${encodeURIComponent(jobId)}/render/${encodeURIComponent(l.lessonId)}.mp4`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Ver MP4
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </StepCard>
      </ol>

      {/* ============ MODO EXPERTO ============ */}
      <details className="expert-zone">
        <summary>Modo experto</summary>
        <p>
          Corre TODO el pipeline desatendido (preparación → overlays → gates →
          ensamblaje → QA → entrega) sin detenerse en cada paso. Solo para
          cuando confías en la estructura aprobada y no necesitas validar
          etapa por etapa.
        </p>
        <div className="stepper-actions">
          <button
            className="btn btn-danger-outline"
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  "¿Correr todo el pipeline sin intervención? Esto encadena todas las etapas restantes y puede tardar horas."
                )
              ) {
                handleRunAll();
              }
            }}
            disabled={runningAll || approval === null}
            title={
              approval === null
                ? "Requiere la estructura aprobada (paso 3)"
                : undefined
            }
          >
            {runningAll
              ? "Iniciando corrida completa…"
              : "Correr todo sin intervención (run-all)"}
          </button>
        </div>
        {runAllError && <p className="stepper-error-msg">{runAllError}</p>}
      </details>
    </main>
  );
}
