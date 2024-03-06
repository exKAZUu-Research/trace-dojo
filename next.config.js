/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
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
