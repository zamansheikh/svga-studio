"use client";

import { useEffect, useState } from "react";
import * as svga from "@/lib/svga";
import * as renderer from "@/lib/renderer";
import * as detect from "@/lib/text/detect";
import * as raster from "@/lib/text/raster";
import * as items from "@/lib/text/items";
import * as style from "@/lib/text/style";
import * as fontmatch from "@/lib/text/fontmatch";
import * as fonts from "@/lib/text/fonts";

/** Renders frame `frame` of a movie into a canvas `scale` times the viewBox. */
async function renderFrame(movie: svga.MovieFile, frame: number, maxSide = 256): Promise<HTMLCanvasElement> {
  const s = Math.min(1, maxSide / Math.max(movie.params.viewBoxWidth, movie.params.viewBoxHeight));
  return renderer.renderFrameCanvas(movie, frame, s);
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export default function Lab() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    Object.assign(window, { __lab: { svga, renderer, detect, raster, items, style, fontmatch, fonts, renderFrame, b64 } });
    setReady(true);
  }, []);
  return <div id="lab" data-ready={ready ? "1" : "0"} style={{ padding: 16, color: "#fff" }}>lab {ready ? "ready" : "loading"}</div>;
}
