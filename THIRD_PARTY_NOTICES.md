# Third-party software

mydash itself is MIT licensed (see LICENSE). It depends on, or downloads at install time, the following.

## npm dependencies (installed by `npm ci`, not stored in this repository)

| Package | Version | License | Used for |
|---|---|---|---|
| [marked](https://github.com/markedjs/marked) | 18.x | MIT | Markdown rendering |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.x | BSD-3-Clause | code highlighting |
| [mermaid](https://github.com/mermaid-js/mermaid) | 12.x | MIT | diagrams in Markdown |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | 4.x | Apache-2.0 | in-browser PDF fallback |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 1.x | BSD-2-Clause | Word text view |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 2.x | MIT | QR code for opening mydash on the same Wi-Fi |
| [SheetJS Community Edition (xlsx)](https://git.sheetjs.com/sheetjs/sheetjs) | 0.20.x | Apache-2.0 | Excel tables (installed from cdn.sheetjs.com, as SheetJS recommends) |

## Bundled in this repository

| Asset | License |
|---|---|
| `static/fonts/Geist-Variable.woff2`, `static/fonts/GeistMono-Variable.woff2`: [Geist](https://github.com/vercel/geist-font) by Vercel | SIL Open Font License 1.1 (`static/fonts/OFL.txt`) |

## Downloaded or used at install time, when the matching option is chosen

| Software | License | When |
|---|---|---|
| [Noto Sans SC / Noto Serif SC](https://github.com/notofonts/noto-cjk) | SIL Open Font License 1.1 | macOS with LibreOffice: copied into mydash's LibreOffice clone so Chinese text survives the PDF conversion |
| [Tailscale](https://github.com/tailscale/tailscale) `tailscale` / `tailscaled` | BSD-3-Clause | `--access tailscale-node`: built from source with Go (macOS) or downloaded from pkgs.tailscale.com (Linux) |
| [LibreOffice](https://www.libreoffice.org/) | MPL-2.0 | used if installed, for Word / PowerPoint previews; never bundled |
| [Poppler](https://poppler.freedesktop.org/) `pdftoppm` | GPL-2.0-or-later | Linux: used if installed, for PDF page images; never bundled |
