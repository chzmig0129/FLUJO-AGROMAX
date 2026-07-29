"use client";

/**
 * Barra de progreso del wizard: determinada (X/N con porcentaje) o
 * indeterminada (cuando la etapa corre pero no reporta granularidad).
 */
export function ProgressBar({
  done,
  total,
  label,
  indeterminate = false,
}: {
  done?: number;
  total?: number;
  label?: string;
  indeterminate?: boolean;
}) {
  const pct =
    !indeterminate && typeof done === "number" && typeof total === "number" && total > 0
      ? Math.min(100, Math.round((done / total) * 100))
      : 0;

  return (
    <div>
      <div className="pbar-track">
        <div
          className={`pbar-fill${indeterminate ? " pbar-fill--indeterminate" : ""}`}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      {label && <p className="pbar-label">{label}</p>}
    </div>
  );
}
