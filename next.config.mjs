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
};

export default nextConfig;
