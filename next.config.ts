import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ['@chakra-ui/react', 'supertokens-auth-react'],
    turbopackFileSystemCacheForDev: true,
  },
  productionBrowserSourceMaps: true,
  reactCompiler: true,
  reactStrictMode: true,
  serverExternalPackages: ['pino', 'koffi'],
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
