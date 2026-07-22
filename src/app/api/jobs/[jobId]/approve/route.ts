/**
 * POST /api/jobs/[jobId]/approve — registra la aprobación humana de
 * plan/structure.json tal como está en disco (etapa 6, gate de aprobación).
 *
 * Valida que el job exista (404 si no) y que su status permita aprobar (400
 * si todavía no fue planeado). Escribe plan/approval.json con
 * approvedAt=now. La preparación (POST /prep) exige que este archivo exista
 * (o que se pase force:true) antes de correr.
 */
import { NextResponse } from "next/server";
import { readJobJson, writeApprovalJson } from "@/lib/jobs";
import type { Approval, JobStatus } from "@/lib/types";

export const runtime = "nodejs";

/** Estados desde los que tiene sentido aprobar la estructura. */
const APPROVABLE_STATUSES: JobStatus[] = ["planned", "prepared"];

export async function POST(
  _request: Request,
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

  if (!APPROVABLE_STATUSES.includes(job.status)) {
    return NextResponse.json(
      {
        error: `No se puede aprobar la estructura: el proyecto debe estar planeado primero (status actual: "${job.status}")`,
      },
      { status: 400 }
    );
  }

  const approval: Approval = { approvedAt: new Date().toISOString() };
  await writeApprovalJson(jobId, approval);

  return NextResponse.json({ ok: true, approval });
}
