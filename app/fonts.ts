import { Bebas_Neue, Cinzel, Great_Vibes, Lobster, Luckiest_Guy, Montserrat, Oswald, Playfair_Display, Russo_One } from "next/font/google";

/*
 * Fonts offered for new text. Self-hosted by next/font (downloaded at build
 * time, served from this site), not preloaded: a font is fetched the first
 * time someone draws with it.
 */
export const montserrat = Montserrat({ subsets: ["latin", "latin-ext", "cyrillic", "vietnamese"], weight: "variable", style: ["normal", "italic"], display: "swap", preload: false, variable: "--font-montserrat" });
export const oswald = Oswald({ subsets: ["latin", "latin-ext", "cyrillic"], weight: "variable", display: "swap", preload: false, variable: "--font-oswald" });
export const cinzel = Cinzel({ subsets: ["latin", "latin-ext"], weight: "variable", display: "swap", preload: false, variable: "--font-cinzel" });
export const playfair = Playfair_Display({ subsets: ["latin", "latin-ext", "cyrillic"], weight: "variable", style: ["normal", "italic"], display: "swap", preload: false, variable: "--font-playfair" });
export const lobster = Lobster({ subsets: ["latin", "latin-ext", "cyrillic"], weight: "400", display: "swap", preload: false, variable: "--font-lobster" });
export const bebas = Bebas_Neue({ subsets: ["latin", "latin-ext"], weight: "400", display: "swap", preload: false, variable: "--font-bebas" });
export const russo = Russo_One({ subsets: ["latin", "cyrillic"], weight: "400", display: "swap", preload: false, variable: "--font-russo" });
export const luckiest = Luckiest_Guy({ subsets: ["latin"], weight: "400", display: "swap", preload: false, variable: "--font-luckiest" });
export const greatVibes = Great_Vibes({ subsets: ["latin", "latin-ext", "cyrillic"], weight: "400", display: "swap", preload: false, variable: "--font-greatvibes" });

export const fontVariables = [montserrat, oswald, cinzel, playfair, lobster, bebas, russo, luckiest, greatVibes].map((f) => f.variable).join(" ");

/** Font family names as the browser knows them, by registry id. */
export const fontFamilies: Record<string, string> = {
  montserrat: montserrat.style.fontFamily,
  oswald: oswald.style.fontFamily,
  cinzel: cinzel.style.fontFamily,
  playfair: playfair.style.fontFamily,
  lobster: lobster.style.fontFamily,
  bebas: bebas.style.fontFamily,
  russo: russo.style.fontFamily,
  luckiest: luckiest.style.fontFamily,
  greatvibes: greatVibes.style.fontFamily,
};
