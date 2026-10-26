import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://svga-compressor.vercel.app";
  return [
    { url: `${base}/`, lastModified: new Date(), changeFrequency: "monthly", priority: 1 },
    { url: `${base}/edit`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/icons`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
  ];
}
