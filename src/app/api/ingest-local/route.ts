/**
 * POST /api/ingest-local — ingesta de un ZIP de videos que YA está presente
 * en el disco del server (p.ej. copiado por scp/USB), en vez de subirlo por
 * HTTP. Pensado para ZIPs demasiado grandes para el upload por navegador
 * (ver /api/ingest): con ingest-local no hay transferencia de red de por
 * medio, solo se lee el archivo local.
 *
 * Body JSON: { "zipPath": "C:\\ruta\\al.zip" } (o una ruta POSIX si el
 * server corre en Linux/macOS). La ruta puede venir con separadores '/' o
 * '\\' indistintamente: se normaliza con path.resolve antes de validar.
 *
 * Validaciones antes de tocar nada: el path debe existir, ser un archivo
 * regular con extensión .zip, y NO debe estar dentro de jobs/ (evita que el
 * usuario apunte por error a un ZIP que ya es parte de otro job).
 *
 * El ZIP original NUNCA se borra ni se mueve: no es nuestro archivo. Se
 * copia a jobs/<id>/upload.zip antes de extraer, y esa copia (no el
 * original) es la que se borra al terminar de extraer, igual que en
 * /api/ingest.
 *
 * A partir de ahí corre el MISMO flujo que /api/ingest (extraer a source/
 * → probeAll → job.json → runPipeline en background) vía el helper
 * compartido en @/lib/ingest, y responde {jobId, files} igual.
 *
 * Server-only: corre en runtime Node.js (no Edge) porque usa fs,
 * child_process (ffprobe) y yauzl.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createJobDir, jobPath, JOBS_ROOT } from "@/lib/jobs";
import { ingestFromLocalZip, isKnownZipError } from "@/lib/ingest";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "El body debe ser JSON válido" },
      { status: 400 }
    );
  }

  const zipPath =
    body && typeof body === "object" && "zipPath" in body
      ? (body as { zipPath: unknown }).zipPath
      : undefined;

  if (typeof zipPath !== "string" || zipPath.trim() === "") {
    return NextResponse.json(
      { error: "Falta zipPath (string) en el body" },
      { status: 400 }
    );
  }

  // Normalizamos la ruta (funciona tanto con '\\' como con '/' porque
  // path.resolve en Node interpreta ambos separadores en Windows; en
  // POSIX el '\\' quedaría como parte del nombre, pero ese es el
  // comportamiento nativo del propio runtime del server).
  const resolvedZipPath = path.resolve(zipPath);

  if (!resolvedZipPath.toLowerCase().endsWith(".zip")) {
    return NextResponse.json(
      { error: "El archivo debe ser un ZIP" },
      { status: 400 }
    );
  }

  // No permitimos apuntar a un ZIP que ya vive dentro de jobs/ (por
  // ejemplo el upload.zip de otro job a medio procesar).
  const relativeToJobsRoot = path.relative(JOBS_ROOT, resolvedZipPath);
  const isInsideJobsRoot =
    relativeToJobsRoot !== "" &&
    !relativeToJobsRoot.startsWith("..") &&
    !path.isAbsolute(relativeToJobsRoot);
  if (isInsideJobsRoot) {
    return NextResponse.json(
      { error: "zipPath no puede estar dentro de jobs/" },
      { status: 400 }
    );
  }

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(resolvedZipPath);
  } catch {
    return NextResponse.json(
      { error: `No existe el archivo: ${resolvedZipPath}` },
      { status: 400 }
    );
  }

  if (!stat.isFile()) {
    return NextResponse.json(
      { error: `No es un archivo regular: ${resolvedZipPath}` },
      { status: 400 }
    );
  }

  // El nombre del proyecto se deriva del nombre del archivo ZIP local.
  const name = path.basename(resolvedZipPath, path.extname(resolvedZipPath));

  const id = crypto.randomUUID();

  // A partir de aquí, cualquier error debe limpiar jobs/<id>/ antes de
  // responder. El ZIP original en resolvedZipPath NUNCA se toca: solo se
  // copia a upload.zip dentro del job.
  try {
    await createJobDir(id);

    const uploadZipPath = path.join(jobPath(id), "upload.zip");
    await fs.copyFile(resolvedZipPath, uploadZipPath);

    const { files } = await ingestFromLocalZip(id, name, uploadZipPath);

    return NextResponse.json({ jobId: id, files });
  } catch (err) {
    console.error(
      "Error en POST /api/ingest-local:",
      err instanceof Error ? err.stack ?? err.message : err
    );

    // Limpiamos cualquier rastro del job a medio crear (el ZIP original en
    // resolvedZipPath jamás se toca, solo la copia dentro de jobs/<id>/).
    await fs.rm(jobPath(id), { recursive: true, force: true });

    const message =
      err instanceof Error ? err.message : "Error inesperado procesando el ZIP";

    return NextResponse.json(
      { error: message },
      { status: isKnownZipError(message) ? 400 : 500 }
    );
  }
}
