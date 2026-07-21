/**
 * Declaración de los imports de archivos de fuente. El bundler de Remotion
 * los resuelve como 'asset/resource' (devuelven una URL), pero TypeScript
 * necesita saberlo explícitamente.
 */
declare module "*.ttf" {
  const src: string;
  export default src;
}

declare module "*.woff2" {
  const src: string;
  export default src;
}
