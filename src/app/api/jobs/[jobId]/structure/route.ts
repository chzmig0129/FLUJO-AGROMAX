/**
 * PUT /api/jobs/[jobId]/structure — reemplaza plan/structure.json de un job
 * con la estructura editada por un humano en la UI (etapa 6, gate de
 * aprobación).
 *
 * Valida que el job exista (404 si no), que su status permita editar la
 * estructura (400 si todavía no fue planeado) y que el body tenga la forma
 * mínima de un StructureJson (400 si no) — solo forma (modules/lessons con
 * id/title/segments), sin re-validar contra clips ni frames, eso ya lo hizo
 * la etapa de plan.
 *
 * Escribir una nueva estructura invalida cualquier aprobación previa: por
 * eso este endpoint borra plan/approval.json después de escribir. Un humano
 * debe volver a aprobar explícitamente vía POST /approve.
 */
import { NextResponse } from "next/server";
import {
  deleteApprovalJson,
  readJobJson,
  writeStructureJson,
} from "@/lib/jobs";
import type { JobStatus, StructureJson } from "@/lib/types";

export const runtime = "nodejs";

/** Estados desde los que tiene sentido editar la estructura. */
const STRUCTURE_EDITABLE_STATUSES: JobStatus[] = ["planned", "prepared"];

/**
 * Valida (tolerante, solo forma) que `value` tenga la forma mínima de un
 * StructureJson: modules es un array, y cada lección de cada módulo tiene
 * id/title/segments. No valida los segmentos en sí ni los cruza contra
 * clips reales — eso es responsabilidad de la etapa de plan, no de este
 * gate.
 */
function isValidStructureShape(value: unknown): value is StructureJson {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.courseTitle !== "string") return false;
  if (!Array.isArray(candidate.modules)) return false;

  for (const moduleEntry of candidate.modules) {
    if (typeof moduleEntry !== "object" || moduleEntry === null) return false;
    const mod = moduleEntry as Record<string, unknown>;
    if (!Array.isArray(mod.lessons)) return false;

    for (const lessonEntry of mod.lessons) {
      if (typeof lessonEntry !== "object" || lessonEntry === null) return false;
      const lesson = lessonEntry as Record<string, unknown>;
      if (typeof lesson.id !== "string") return false;
      if (typeof lesson.title !== "string") return false;
      if (!Array.isArray(lesson.segments)) return false;
    }
  }

  return true;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  let job;
  try {
    job = await readJobJson(jobId);
  } catch {
    return NextResponse.json(
      { error: "Proyecto no encontrado" },
      { status: 404 }
    );
  }

  if (!STRUCTURE_EDITABLE_STATUSES.includes(job.status)) {
    return NextResponse.json(
      {
        error: `No se puede editar la estructura: el proyecto debe estar planeado primero (status actual: "${job.status}")`,
      },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body inválido: se esperaba JSON con { structure }" },
      { status: 400 }
    );
  }

  const structure =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).structure
      : undefined;

  if (!isValidStructureShape(structure)) {
    return NextResponse.json(
      {
        error:
          "Estructura inválida: se esperaba { structure: { courseTitle, modules: [{ lessons: [{ id, title, segments }] }] } }",
      },
      { status: 400 }
    );
  }

  await writeStructureJson(jobId, structure);
  // Editar la estructura invalida cualquier aprobación previa.
  await deleteApprovalJson(jobId);

  return NextResponse.json({ ok: true });
}
