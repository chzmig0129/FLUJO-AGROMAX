/**
 * GET /api/jobs/[jobId]/frames/[...path] — sirve un JPG generado por la
 * etapa de muestreo de frames (jobs/<id>/frames/<...path>) como
 * image/jpeg.
 *
 * SEGURIDAD: el path viene de la URL, así que se resuelve con path.resolve
 * y se verifica que el resultado siga empezando con framesDir(id) resuelto,
 * para bloquear cualquier intento de path traversal (por ejemplo
 * "../../job.json"). Solo se sirven archivos con extensión .jpg.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { framesDir } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string; path: string[] }> }
) {
  const { jobId, path: pathSegments } = await params;

  const baseDir = path.resolve(framesDir(jobId));
  const requestedPath = path.resolve(baseDir, ...pathSegments);

  // Anti-traversal: la ruta resuelta debe seguir dentro de frames/<id>/.
  const isInsideFramesDir =
    requestedPath === baseDir ||
    requestedPath.startsWith(baseDir + path.sep);

  if (!isInsideFramesDir || path.extname(requestedPath) !== ".jpg") {
    return NextResponse.json(
      { error: "Frame no encontrado" },
      { status: 404 }
    );
  }

  try {
    const data = await fs.readFile(requestedPath);
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Frame no encontrado" },
      { status: 404 }
    );
  }
}
