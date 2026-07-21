/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['ffprobe-static', 'ffmpeg-static', 'yauzl'],
};

export default nextConfig;
