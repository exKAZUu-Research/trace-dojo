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
    serverComponentsExternalPackages: ['pino'],
    optimizePackageImports: ['@chakra-ui/react', 'supertokens-auth-react'],
    staleTimes: {
      dynamic: 0,
      static: 0,
    },
  },
};

module.exports = nextConfig;
