/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['ffprobe-static', 'ffmpeg-static', 'yauzl', '@anthropic-ai/sdk'],
};

export default nextConfig;
