/** @type {import('next').NextConfig} */
const nextConfig = {
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
  reactStrictMode: true,
  serverExternalPackages: ['pino'],
  typescript: {
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;
