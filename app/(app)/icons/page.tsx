import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Batch icons",
  description: "Turn many SVGA animations into still icons at once and download them as a zip.",
};

// The batch tool lives in the (app) layout so it survives switching tools.
export default function IconsPage() {
  return null;
}
