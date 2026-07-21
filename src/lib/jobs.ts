/**
 * jobs.ts — persistencia de jobs en filesystem (solo servidor).
 *
 * Estructura en disco:
 *   jobs/<id>/source/    archivos de video originales, tal como se extraen del ZIP
 *   jobs/<id>/job.json   metadata del job (JobJson)
 *   jobs/<id>/order.json orden/títulos confirmados por el usuario (OrderJson)
 *
 * INVARIANTE IMPORTANTE: jobs/<id>/source/ es inmutable una vez creada en la
 * ingesta. Ningún código posterior (confirm, etapas futuras del pipeline)
 * debe escribir, mover ni borrar archivos dentro de source/. Solo se leen.
 *
 * Este módulo es server-only: usa node:fs/promises y node:path, por lo que
 * nunca debe importarse desde código de cliente (componentes "use client").
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JobJson, OrderJson } from "./types";

/** Raíz absoluta donde viven todos los jobs (jobs/ en la raíz del proyecto). */
export const JOBS_ROOT = path.join(process.cwd(), "jobs");

/** Ruta absoluta al directorio de un job dado su id. */
export function jobPath(id: string): string {
  return path.join(JOBS_ROOT, id);
}

/** Ruta absoluta al subdirectorio inmutable source/ de un job. */
export function sourcePath(id: string): string {
  return path.join(jobPath(id), "source");
}

/** Ruta absoluta a job.json de un job. */
function jobJsonPath(id: string): string {
  return path.join(jobPath(id), "job.json");
}

/** Ruta absoluta a order.json de un job. */
function orderJsonPath(id: string): string {
  return path.join(jobPath(id), "order.json");
}

/**
 * Crea jobs/<id>/source/ de forma recursiva (y por lo tanto jobs/<id>/).
 * Debe llamarse una única vez al iniciar la ingesta de un job; después de
 * esto, source/ no vuelve a modificarse (ver invariante en el header).
 */
export async function createJobDir(id: string): Promise<void> {
  await fs.mkdir(sourcePath(id), { recursive: true });
}

/**
 * Escribe (o sobrescribe) job.json, refrescando siempre updatedAt al momento
 * de la escritura. createdAt no se toca aquí: debe venir ya seteado por
 * quien construye el objeto JobJson la primera vez.
 */
export async function writeJobJson(job: JobJson): Promise<void> {
  const jobToWrite: JobJson = {
    ...job,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    jobJsonPath(jobToWrite.id),
    JSON.stringify(jobToWrite, null, 2),
    "utf-8"
  );
}

/**
 * Lee job.json de un job. Lanza un error claro (en español) si el job no
 * existe o el archivo no puede leerse, en vez de propagar el ENOENT crudo.
 */
export async function readJobJson(id: string): Promise<JobJson> {
  try {
    const raw = await fs.readFile(jobJsonPath(id), "utf-8");
    return JSON.parse(raw) as JobJson;
  } catch {
    throw new Error(`Proyecto no encontrado: no existe el job "${id}"`);
  }
}

/**
 * Escribe (o sobrescribe) order.json con el orden/títulos confirmados por
 * el usuario. No toca job.json ni source/.
 */
export async function writeOrderJson(id: string, order: OrderJson): Promise<void> {
  await fs.writeFile(orderJsonPath(id), JSON.stringify(order, null, 2), "utf-8");
}
