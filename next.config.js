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
  // The build container on the deploy box is memory-constrained (shared with
  // Dograh's own stack and several other apps) -- Next's in-build
  // type-check and lint passes are a full separate project traversal on top
  // of the webpack/SWC compile itself, and have been observed OOM-killing
  // the build with no readable error (just an abrupt stop after "Creating
  // an optimized production build..."). Both are redundant with `npx tsc
  // --noEmit`, which is run locally before every push instead.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
