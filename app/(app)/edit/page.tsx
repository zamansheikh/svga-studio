import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Editor",
  description: "Edit the text, layers and size of an SVGA animation in your browser.",
};

// The editor itself lives in the (app) layout so it survives switching tools.
export default function EditPage() {
  return null;
}
