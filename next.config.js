/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    // https://github.com/vercel/next.js/discussions/46987
    serverComponentsExternalPackages: ['pino'],
  },
};

module.exports = nextConfig;
