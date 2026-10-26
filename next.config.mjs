/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev-only Next badge sits on top of the app's bottom-left controls.
  devIndicators: false,
  allowedDevOrigins: ['192.168.68.51','192.168.139.3'],
};

export default nextConfig;
