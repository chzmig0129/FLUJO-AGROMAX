"use client";

/**
 * StepCard — un paso del wizard vertical del job.
 *
 * Renderiza el nodo del riel (número o ✓), la tarjeta con título, chip de
 * estado en español, chip de tiempo transcurrido y barra de progreso X/N, y
 * el cuerpo colapsable. Se auto-abre cuando el paso pasa a 'corriendo',
 * 'atencion' o 'error' (los estados que requieren la vista del usuario);
 * el usuario puede abrir/cerrar cualquier paso con el header.
 */
import { ReactNode, useEffect, useRef, useState } from "react";
import { ProgressBar } from "./ProgressBar";

export type StepState =
  | "pendiente"
  | "corriendo"
  | "atencion"
  | "listo"
  | "error"
  | "bloqueado";

const STATE_LABEL: Record<StepState, string> = {
  pendiente: "Pendiente",
  corriendo: "En curso",
  atencion: "Requiere tu revisión",
  listo: "Listo",
  error: "Error",
  bloqueado: "Bloqueado",
};

const AUTO_OPEN_STATES: StepState[] = ["corriendo", "atencion", "error"];

export function StepCard({
  index,
  title,
  state,
  elapsed,
  progress,
  desc,
  lockedHint,
  children,
  defaultOpen,
}: {
  index: number;
  title: string;
  state: StepState;
  /** Chip "⏱ 3m 12s" (tiempo transcurrido de la etapa), o null si no arrancó. */
  elapsed?: string | null;
  /** Barra X/N en vivo mientras la etapa corre. */
  progress?: { done: number; total: number; label?: string } | null;
  /** Línea de contexto bajo el título, dentro del cuerpo. */
  desc?: string;
  /** Mensaje mostrado cuando el paso está bloqueado (previa sin terminar). */
  lockedHint?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState<boolean>(
    defaultOpen ?? AUTO_OPEN_STATES.includes(state)
  );
  const prevState = useRef<StepState>(state);

  // Auto-abrir cuando el paso entra en un estado que pide atención.
  useEffect(() => {
    if (prevState.current !== state && AUTO_OPEN_STATES.includes(state)) {
      setOpen(true);
    }
    prevState.current = state;
  }, [state]);

  const showProgress =
    progress && progress.total > 0 && state === "corriendo";

  return (
    <li className={`wz-step wz-step--${state}`}>
      <div className="wz-node" aria-hidden="true">
        {state === "listo" ? "✓" : state === "error" ? "!" : index}
      </div>
      <div className="wz-card">
        <button
          type="button"
          className="wz-card-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="wz-title">{title}</span>
          <span className="wz-chips">
            {elapsed && <span className="wz-chip wz-chip-time">⏱ {elapsed}</span>}
            <span className={`wz-chip wz-chip--${state}`}>
              {state === "corriendo" && (
                <span className="spinner" aria-hidden="true" />
              )}
              {STATE_LABEL[state]}
            </span>
          </span>
          <span className={`wz-caret${open ? " wz-caret--open" : ""}`}>▶</span>
        </button>

        {showProgress && (
          <div className="wz-head-progress">
            <ProgressBar
              done={progress.done}
              total={progress.total}
              label={
                progress.label ??
                `${progress.done}/${progress.total} (${Math.round(
                  (progress.done / progress.total) * 100
                )}%)`
              }
            />
          </div>
        )}

        {open && (
          <div className="wz-body">
            {desc && <p className="wz-desc">{desc}</p>}
            {state === "bloqueado" && lockedHint ? (
              <p className="wz-lock-hint">{lockedHint}</p>
            ) : (
              children
            )}
          </div>
        )}
      </div>
    </li>
  );
}
