/**
 * POST /api/jobs/[jobId]/confirm — confirma el orden y los títulos elegidos
 * por el usuario para los videos de un job.
 *
 * Body esperado: { order: [{ file, title }, ...] }
 *
 * Efectos:
 *   - Escribe jobs/<id>/order.json con el orden/títulos confirmados.
 *   - Actualiza jobs/<id>/job.json: status pasa a 'ingested' (writeJobJson
 *     también refresca updatedAt automáticamente).
 *
 * Esta ruta SOLO escribe job.json y order.json. Jamás toca
 * jobs/<id>/source/, que es inmutable una vez creada la ingesta (ver
 * invariante en src/lib/jobs.ts).
 */
import { NextResponse } from "next/server";
import { readJobJson, writeJobJson, writeOrderJson } from "@/lib/jobs";
import type { OrderEntry } from "@/lib/types";

export const runtime = "nodejs";

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  // 1. El job debe existir.
  let job;
  try {
    job = await readJobJson(jobId);
  } catch {
    return NextResponse.json(
      { error: "Proyecto no encontrado" },
      { status: 404 }
    );
  }

  // 2. El body debe tener un JSON válido.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("El cuerpo de la solicitud no es JSON válido");
  }

  const order = (body as { order?: unknown } | null)?.order;

  // 3. order debe ser un array no vacío.
  if (!Array.isArray(order) || order.length === 0) {
    return badRequest("'order' debe ser un arreglo no vacío de { file, title }");
  }

  // 4. Cada entrada debe tener file y title como string.
  const entries = order as unknown[];
  for (const entry of entries) {
    const e = entry as Partial<OrderEntry> | null;
    if (
      !e ||
      typeof e.file !== "string" ||
      e.file.length === 0 ||
      typeof e.title !== "string" ||
      e.title.length === 0
    ) {
      return badRequest(
        "Cada entrada de 'order' debe tener 'file' y 'title' como texto no vacío"
      );
    }
  }

  const orderEntries = entries as OrderEntry[];

  // 5. El conjunto de files debe coincidir EXACTAMENTE con job.files:
  //    sin faltantes, sin sobrantes y sin duplicados.
  const orderFiles = orderEntries.map((e) => e.file);
  const orderFilesSet = new Set(orderFiles);

  if (orderFilesSet.size !== orderFiles.length) {
    return badRequest("'order' contiene archivos duplicados");
  }

  const jobFilenames = job.files.map((f) => f.filename);
  const jobFilesSet = new Set(jobFilenames);

  const faltantes = jobFilenames.filter((f) => !orderFilesSet.has(f));
  const sobrantes = orderFiles.filter((f) => !jobFilesSet.has(f));

  if (faltantes.length > 0 || sobrantes.length > 0) {
    const partes: string[] = [];
    if (faltantes.length > 0) {
      partes.push(`faltan: ${faltantes.join(", ")}`);
    }
    if (sobrantes.length > 0) {
      partes.push(`sobran: ${sobrantes.join(", ")}`);
    }
    return badRequest(
      `'order' no coincide con los archivos del job (${partes.join("; ")})`
    );
  }

  // Todo validado: persistir order.json y actualizar el estado del job.
  await writeOrderJson(jobId, { order: orderEntries });
  await writeJobJson({ ...job, status: "ingested" });

  return NextResponse.json({ ok: true });
}
