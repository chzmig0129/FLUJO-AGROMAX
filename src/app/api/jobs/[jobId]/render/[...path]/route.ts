/**
 * GET /api/jobs/[jobId]/render/[...path] — sirve un MP4 ensamblado
 * (jobs/<id>/render/<lessonId>.mp4) para reproducirlo en el navegador.
 *
 * SOPORTA HTTP RANGE, y no es un lujo: sin respuestas 206 el <video> del
 * navegador no puede buscar dentro del archivo (y Safari directamente se
 * niega a reproducir). Un GET sin Range devuelve 200 con el archivo entero;
 * uno con Range devuelve 206 con el tramo pedido.
 *
 * SEGURIDAD: igual que la ruta de frames, el path viene de la URL, así que
 * se resuelve y se verifica que siga dentro de render/ (anti path traversal)
 * y que la extensión sea .mp4.
 *
 * COMPLETITUD: solo se sirven renders que tienen sidecar 'complete'. Un MP4
 * presente pero no verificado (por ejemplo de una corrida vieja interrumpida
 * antes de que existiera el sidecar) NO se entrega: es preferible un 404 a
 * dejar que el usuario vea media clase y crea que eso es el resultado.
 */
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { readRenderSidecar, renderDir } from "@/lib/jobs";

export const runtime = "nodejs";

/** Parsea un header Range simple ("bytes=START-END"). Devuelve null si no aplica. */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;

  // Sufijo ("bytes=-500"): los últimos N bytes.
  if (rawStart === "") {
    if (rawEnd === "") return null;
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;

  return { start, end: Math.min(end, size - 1) };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string; path: string[] }> }
) {
  const { jobId, path: pathSegments } = await params;

  const baseDir = path.resolve(renderDir(jobId));
  const requestedPath = path.resolve(baseDir, ...pathSegments);

  const isInsideRenderDir =
    requestedPath === baseDir || requestedPath.startsWith(baseDir + path.sep);

  if (!isInsideRenderDir || path.extname(requestedPath) !== ".mp4") {
    return NextResponse.json({ error: "Render no encontrado" }, { status: 404 });
  }

  // Solo renders verificados: la existencia del archivo no alcanza.
  const lessonId = path.basename(requestedPath, ".mp4");
  const sidecar = await readRenderSidecar(jobId, lessonId);
  if (!sidecar) {
    return NextResponse.json(
      { error: "El render de esa clase todavía no está verificado como completo" },
      { status: 404 }
    );
  }

  let size: number;
  try {
    const stat = await fs.stat(requestedPath);
    size = stat.size;
  } catch {
    return NextResponse.json({ error: "Render no encontrado" }, { status: 404 });
  }

  const range = parseRange(request.headers.get("range"), size);

  const commonHeaders = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };

  if (!range) {
    const stream = Readable.toWeb(
      createReadStream(requestedPath)
    ) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: { ...commonHeaders, "content-length": String(size) },
    });
  }

  const stream = Readable.toWeb(
    createReadStream(requestedPath, { start: range.start, end: range.end })
  ) as ReadableStream;

  return new Response(stream, {
    status: 206,
    headers: {
      ...commonHeaders,
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    },
  });
}
