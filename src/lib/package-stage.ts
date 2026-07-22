/**
 * package-stage.ts — etapa 16 del diseño: empaquetado de entrega.
 *
 * Arma una carpeta `deliver/CURSO_<slug>/` auditable con el .mp4 final de
 * cada clase renombrado, un `NOTAS.md` por clase (contenido, cortes usados,
 * duración, veredicto de Gate 2 si existe, correcciones de captions si
 * existen), y tres archivos a nivel de curso: `ESTRUCTURA_CURSO.md` (render
 * legible de plan/structure.json), `QA_LOG.md` (veredictos de Gate 2/Gate 3
 * recopilados) y `DECISIONES.md` (copia de plan/decisiones.md si existe).
 * Termina escribiendo `deliver/manifest.json` (ver PackageManifest).
 *
 * Idempotente: antes de escribir, borra cualquier `deliver/CURSO_*` previo.
 * No toca render/ ni ningún otro directorio de entrada: solo LEE de ahí y
 * escribe en deliver/.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  deliverDir,
  jobPath,
  packageManifestPath,
  planDir,
  readCutsFiles,
  readDecisionesMd,
  readGate2Verdict,
  readJobJson,
  readStructureJson,
  renderPath,
} from "./jobs";
import type { CutsFile, PackageManifest, StructureJson } from "./types";

/**
 * Normaliza un texto libre a un slug seguro para nombres de archivo/carpeta:
 * sin acentos (NFD + strip de diacríticos), espacios reemplazados por "_",
 * y solo caracteres [A-Za-z0-9_-] sobreviven.
 */
export function slugify(input: string): string {
  const withoutAccents = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const withUnderscores = withoutAccents.replace(/\s+/g, "_");
  const cleaned = withUnderscores.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "sin_titulo";
}

/** Ruta absoluta a plan/captions-audit.json de un job (etapa 12). */
function captionsAuditJsonPath(jobId: string): string {
  return path.join(planDir(jobId), "captions-audit.json");
}

/**
 * Lee plan/captions-audit.json de un job de forma tolerante. Devuelve null
 * si no existe o no es JSON válido. El tipo se deja sin normalizar: la
 * forma exacta la decide `formatCaptionsCorrections`.
 */
async function readCaptionsAudit(jobId: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(captionsAuditJsonPath(jobId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Lee qa/gate3/<lessonId>.json de un job de forma tolerante (Gate 3 todavía
 * no tiene módulo dedicado en jobs.ts; se lee directo del filesystem).
 * Devuelve null si no existe o no es JSON válido.
 */
async function readGate3Verdict(
  jobId: string,
  lessonId: string
): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(
      path.join(jobPath(jobId), "qa", "gate3", `${lessonId}.json`),
      "utf-8"
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Intenta extraer, de forma tolerante, las correcciones de captions
 * relevantes a una lección desde el contenido crudo de captions-audit.json.
 * Soporta tanto un array de items con `lessonId`, como un objeto indexado
 * por lessonId. Si no reconoce la forma, devuelve null (no rompe el
 * empaquetado por un formato inesperado).
 */
function extractCaptionsCorrections(
  captionsAudit: unknown,
  lessonId: string
): unknown | null {
  if (!captionsAudit || typeof captionsAudit !== "object") return null;
  if (Array.isArray(captionsAudit)) {
    const items = captionsAudit.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).lessonId === lessonId
    );
    return items.length > 0 ? items : null;
  }
  const record = captionsAudit as Record<string, unknown>;
  if (lessonId in record) return record[lessonId];
  if ("lessons" in record && record.lessons && typeof record.lessons === "object") {
    const lessons = record.lessons as Record<string, unknown>;
    if (lessonId in lessons) return lessons[lessonId];
  }
  return null;
}

/** Formatea un veredicto de gate (Gate 2 o Gate 3) como bullet Markdown. */
function formatGateVerdict(label: string, verdict: unknown): string {
  if (!verdict || typeof verdict !== "object") {
    return `- ${label}: (sin veredicto)`;
  }
  const record = verdict as Record<string, unknown>;
  const veredicto = typeof record.verdict === "string" ? record.verdict : "desconocido";
  const razon =
    typeof record.reason === "string"
      ? record.reason
      : typeof record.notes === "string"
        ? record.notes
        : undefined;
  return razon ? `- ${label}: ${veredicto} — ${razon}` : `- ${label}: ${veredicto}`;
}

/** Suma en segundos los rangos `keep` de un CutsFile completo (todos sus clips). */
function sumKeepSeconds(cuts: CutsFile): number {
  let total = 0;
  for (const clip of cuts.clips) {
    for (const range of clip.keep) {
      total += (range.endFrame - range.startFrame) / cuts.fps;
    }
  }
  return total;
}

/** Arma el bloque Markdown de clips y rangos `keep` (en segundos) de una lección. */
function formatKeepRanges(cuts: CutsFile): string {
  const lines: string[] = [];
  for (const clip of cuts.clips) {
    lines.push(`- Clip fuente: \`${clip.clip}\` (tipo: ${clip.kind})`);
    if (clip.keep.length === 0) {
      lines.push("  - (sin rangos conservados)");
      continue;
    }
    for (const range of clip.keep) {
      const startSeconds = (range.startFrame / cuts.fps).toFixed(2);
      const endSeconds = (range.endFrame / cuts.fps).toFixed(2);
      lines.push(`  - keep: ${startSeconds}s → ${endSeconds}s`);
    }
  }
  return lines.join("\n");
}

/** Arma el NOTAS.md de una clase individual. */
async function buildNotasMd(
  jobId: string,
  moduleTitle: string,
  lesson: StructureJson["modules"][number]["lessons"][number],
  cuts: CutsFile | undefined
): Promise<string> {
  const topics = Array.from(
    new Set(lesson.segments.map((segment) => segment.topic).filter(Boolean))
  );

  const gate2Raw = await readGate2Verdict(jobId, lesson.id);
  const gate3Raw = await readGate3Verdict(jobId, lesson.id);
  const captionsAudit = await readCaptionsAudit(jobId);
  const correcciones = extractCaptionsCorrections(captionsAudit, lesson.id);

  const expectedSeconds = cuts ? sumKeepSeconds(cuts) : undefined;

  const lines: string[] = [];
  lines.push(`# ${lesson.title}`);
  lines.push("");
  lines.push(`Módulo: ${moduleTitle}`);
  lines.push(`ID de clase: \`${lesson.id}\``);
  lines.push(`Tipo: ${lesson.kind ?? "normal"}`);
  lines.push("");
  lines.push("## Temas");
  lines.push(topics.length > 0 ? topics.map((t) => `- ${t}`).join("\n") : "(sin temas registrados)");
  lines.push("");
  lines.push("## Clips y rangos conservados (keep)");
  lines.push(cuts ? formatKeepRanges(cuts) : "(sin plan/cuts/ para esta clase)");
  lines.push("");
  lines.push("## Duración");
  lines.push(
    expectedSeconds !== undefined
      ? `Duración esperada (suma de rangos keep, sin intro): ${expectedSeconds.toFixed(2)}s`
      : "(sin datos de cortes para calcular duración esperada)"
  );
  lines.push("");
  lines.push("## QA");
  lines.push(formatGateVerdict("Gate 2 (QA visual)", gate2Raw));
  if (gate3Raw !== null) {
    lines.push(formatGateVerdict("Gate 3", gate3Raw));
  }
  if (correcciones !== null) {
    lines.push("");
    lines.push("### Correcciones de captions");
    lines.push("```json");
    lines.push(JSON.stringify(correcciones, null, 2));
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

/** Arma ESTRUCTURA_CURSO.md: render legible de structure.json. */
function buildEstructuraCursoMd(
  structure: StructureJson,
  cutsByLesson: Map<string, CutsFile>
): string {
  const lines: string[] = [];
  lines.push(`# ${structure.courseTitle}`);
  lines.push("");
  for (const module of [...structure.modules].sort((a, b) => a.order - b.order)) {
    lines.push(`## M${module.order}. ${module.title}`);
    if (module.topics.length > 0) {
      lines.push(`Temas: ${module.topics.join(", ")}`);
    }
    lines.push("");
    for (const lesson of [...module.lessons].sort((a, b) => a.order - b.order)) {
      const cuts = cutsByLesson.get(lesson.id);
      const duration = cuts ? `${sumKeepSeconds(cuts).toFixed(2)}s` : "(sin datos)";
      lines.push(`- C${lesson.order}. ${lesson.title} — duración esperada: ${duration}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Arma QA_LOG.md: recopilación de veredictos de Gate 2 / Gate 3 de todas las clases. */
async function buildQaLogMd(
  jobId: string,
  structure: StructureJson
): Promise<string> {
  const lines: string[] = ["# QA_LOG", ""];
  for (const module of [...structure.modules].sort((a, b) => a.order - b.order)) {
    for (const lesson of [...module.lessons].sort((a, b) => a.order - b.order)) {
      const gate2Raw = await readGate2Verdict(jobId, lesson.id);
      const gate3Raw = await readGate3Verdict(jobId, lesson.id);
      lines.push(`## M${module.order}C${lesson.order} — ${lesson.title} (\`${lesson.id}\`)`);
      lines.push(formatGateVerdict("Gate 2 (QA visual)", gate2Raw));
      if (gate3Raw !== null) {
        lines.push(formatGateVerdict("Gate 3", gate3Raw));
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

/**
 * Borra cualquier `deliver/CURSO_*` previo (idempotencia): un re-run del
 * empaquetado nunca deja carpetas de una corrida vieja mezcladas con la
 * nueva.
 */
async function clearPreviousCourseDirs(jobId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(deliverDir(jobId));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith("CURSO_")) {
      await fs.rm(path.join(deliverDir(jobId), entry), {
        recursive: true,
        force: true,
      });
    }
  }
}

/**
 * Corre la etapa 16 (empaquetado de entrega) para un job: arma
 * `deliver/CURSO_<slug>/` con un .mp4 renombrado por clase, NOTAS.md por
 * clase, y los tres archivos a nivel de curso (ESTRUCTURA_CURSO.md,
 * QA_LOG.md, DECISIONES.md). Escribe deliver/manifest.json al final.
 *
 * Lanza un error claro si falta plan/structure.json, o si a alguna lección
 * de la estructura le falta su render/<lessonId>.mp4 (no se empaqueta una
 * entrega incompleta silenciosamente).
 */
export async function runPackageStage(jobId: string): Promise<void> {
  const job = await readJobJson(jobId);
  const structure = await readStructureJson(jobId);
  if (!structure) {
    throw new Error(
      `No se puede empaquetar: el job '${jobId}' no tiene 'plan/structure.json' (falta correr la etapa de planificación primero).`
    );
  }

  const cutsFiles = await readCutsFiles(jobId);
  const cutsByLesson = new Map(cutsFiles.map((c) => [c.lessonId, c]));

  await fs.mkdir(deliverDir(jobId), { recursive: true });
  await clearPreviousCourseDirs(jobId);

  const courseSlug = slugify(job.name || structure.courseTitle);
  const courseDirName = `CURSO_${courseSlug}`;
  const courseDirAbs = path.join(deliverDir(jobId), courseDirName);
  await fs.mkdir(courseDirAbs, { recursive: true });

  const manifestLessons: PackageManifest["lessons"] = [];

  for (const module of [...structure.modules].sort((a, b) => a.order - b.order)) {
    const moduleSlug = slugify(module.title);
    const moduleDirName = `M${module.order}_${moduleSlug}`;
    const moduleDirAbs = path.join(courseDirAbs, moduleDirName);
    await fs.mkdir(moduleDirAbs, { recursive: true });

    for (const lesson of [...module.lessons].sort((a, b) => a.order - b.order)) {
      const lessonSlug = slugify(lesson.title);
      const lessonDirName = `C${lesson.order}_${lessonSlug}`;
      const lessonDirAbs = path.join(moduleDirAbs, lessonDirName);
      await fs.mkdir(lessonDirAbs, { recursive: true });

      const sourceMp4 = renderPath(jobId, lesson.id);
      try {
        await fs.access(sourceMp4);
      } catch {
        throw new Error(
          `No se puede empaquetar: falta 'render/${lesson.id}.mp4' de la clase '${lesson.title}' (\`${lesson.id}\`). Hay que renderizarla antes de empaquetar el curso.`
        );
      }

      const mp4FileName = `M${module.order}C${lesson.order}_${lessonSlug}.mp4`;
      const mp4DestAbs = path.join(lessonDirAbs, mp4FileName);
      await fs.copyFile(sourceMp4, mp4DestAbs);

      const notasContent = await buildNotasMd(
        jobId,
        module.title,
        lesson,
        cutsByLesson.get(lesson.id)
      );
      const notasDestAbs = path.join(lessonDirAbs, "NOTAS.md");
      await fs.writeFile(notasDestAbs, notasContent, "utf-8");

      manifestLessons.push({
        lessonId: lesson.id,
        moduleId: module.id,
        fileName: path.relative(courseDirAbs, mp4DestAbs),
        notasPath: path.relative(courseDirAbs, notasDestAbs),
      });
    }
  }

  const estructuraMd = buildEstructuraCursoMd(structure, cutsByLesson);
  await fs.writeFile(
    path.join(courseDirAbs, "ESTRUCTURA_CURSO.md"),
    estructuraMd,
    "utf-8"
  );

  const qaLogMd = await buildQaLogMd(jobId, structure);
  await fs.writeFile(path.join(courseDirAbs, "QA_LOG.md"), qaLogMd, "utf-8");

  const decisionesMd = await readDecisionesMd(jobId);
  await fs.writeFile(
    path.join(courseDirAbs, "DECISIONES.md"),
    decisionesMd ?? "(no hay plan/decisiones.md para este job)\n",
    "utf-8"
  );

  const manifest: PackageManifest = {
    packagedAt: new Date().toISOString(),
    courseDir: courseDirName,
    lessons: manifestLessons,
  };
  await fs.writeFile(
    packageManifestPath(jobId),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
}
