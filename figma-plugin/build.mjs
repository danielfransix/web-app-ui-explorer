import fs from "node:fs/promises"
import { build } from "esbuild"

await build({ entryPoints: ["figma-plugin/src/code.ts"], bundle: true, outfile: "figma-plugin/code.js", target: "es2017", format: "iife" })
const ui = await build({ entryPoints: ["figma-plugin/src/ui.ts"], bundle: true, write: false, target: "es2017", format: "iife" })
const template = await fs.readFile("figma-plugin/ui.template.html", "utf8")
const styles = await fs.readFile("figma-plugin/ui.css", "utf8")
let fontCss = await fs.readFile("figma-plugin/assets/plus-jakarta-sans.css", "utf8")
for (const name of new Set([...fontCss.matchAll(/url\(([^)]+)\)/g)].map(match => match[1]))) {
  const font = await fs.readFile("figma-plugin/assets/" + name)
  fontCss = fontCss.replaceAll(name, "data:font/woff2;base64," + font.toString("base64"))
}
await fs.writeFile("figma-plugin/ui.html", template.replace("/* FONT_BUNDLE */", () => fontCss).replace("/* STYLE_BUNDLE */", () => styles).replace("/* UI_BUNDLE */", () => ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")))
