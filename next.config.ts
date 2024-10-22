import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    optimizePackageImports: ['@chakra-ui/react', 'supertokens-auth-react'],
    // 規模が小さいので常時Babelによるコンパイルを有効化する。
    reactCompiler: true,
    staleTimes: {
      dynamic: 0,
      static: 0,
    },
  },
  productionBrowserSourceMaps: true,
  reactStrictMode: true,
  serverExternalPackages: ['pino'],
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
