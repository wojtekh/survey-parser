/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output: bundles just the files needed to run (a minimal
  // node_modules subset + server), not the full source + dev deps -- keeps
  // the Docker image small since this runs on the same box as everything
  // else and shouldn't be a resource hog next to Dograh's own stack.
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['pdf-parse', 'mammoth'],
  },
};

module.exports = nextConfig;
