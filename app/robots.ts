import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://svga-compressor.vercel.app";
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/unlock", "/api/"] }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
