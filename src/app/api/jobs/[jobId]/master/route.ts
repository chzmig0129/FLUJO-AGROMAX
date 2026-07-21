/**
 * GET /api/jobs/[jobId]/master — sirve el archivo transcripts/master.txt de
 * un job como texto plano, para que la UI lo muestre directamente (por
 * ejemplo en un <pre>). 404 en JSON si el job o el archivo no existen.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { transcriptsDir } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    const raw = await fs.readFile(
      path.join(transcriptsDir(jobId), "master.txt"),
      "utf-8"
    );
    return new Response(raw, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch {
    return NextResponse.json(
      { error: "master.txt no encontrado" },
      { status: 404 }
    );
  }
}
