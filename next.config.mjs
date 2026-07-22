/** @type {import('next').NextConfig} */
const nextConfig = {
  // Paquetes que deben quedar FUERA del bundle del servidor: traen binarios
  // nativos y/o su propio bundler. En particular @remotion/bundler arrastra
  // webpack y esbuild (con archivos que el bundler de Next no sabe procesar),
  // y @remotion/renderer carga el compositor nativo por plataforma.
  serverExternalPackages: [
    'ffprobe-static',
    'ffmpeg-static',
    'yauzl',
    '@anthropic-ai/sdk',
    'remotion',
    '@remotion/bundler',
    '@remotion/renderer',
  ],
  // Permite requests de dev-server desde el host tailscale que expone
  // localhost:3000 vía `tailscale serve`. Sin esto, Next 16 bloquea los
  // requests cross-origin del cliente y la UI queda en "Cargando proyecto...".
  allowedDevOrigins: ['itg.tailf75570.ts.net', '100.72.217.107'],
};

export default nextConfig;
