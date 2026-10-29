// pdfpages：用 macOS 自带的 CoreGraphics 把 PDF 每一页渲染成 JPEG（客户端不需要任何 JS 就能看内容）
// 用法：pdfpages <输入.pdf> <输出目录> [宽度像素=1600] [最多页数=150]
// 输出：p001.jpg … 和 pages.json {pages, rendered, items:[{n,file,w,h}]}
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: pdfpages in.pdf outdir [width] [maxPages]\n".data(using: .utf8)!); exit(2) }
let input = URL(fileURLWithPath: args[1])
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
let targetWidth = args.count > 3 ? CGFloat(Int(args[3]) ?? 1600) : 1600
let maxPages = args.count > 4 ? (Int(args[4]) ?? 150) : 150

guard let doc = CGPDFDocument(input as CFURL) else { FileHandle.standardError.write("cannot open pdf\n".data(using: .utf8)!); exit(1) }
if doc.isEncrypted && !doc.unlockWithPassword("") { FileHandle.standardError.write("encrypted pdf\n".data(using: .utf8)!); exit(3) }
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let total = doc.numberOfPages
var items: [[String: Any]] = []
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
if total > 0 {
  for i in 1...min(total, maxPages) {
    guard let page = doc.page(at: i) else { continue }
    let box = page.getBoxRect(.cropBox)
    let rot = ((page.rotationAngle % 360) + 360) % 360
    let W = rot % 180 == 0 ? box.width : box.height
    let H = rot % 180 == 0 ? box.height : box.width
    guard W > 0, H > 0 else { continue }
    var scale = targetWidth / W
    if H * scale > 8000 { scale = 8000 / H }          // 超长页面限制高度，避免内存爆掉
    let pw = Int((W * scale).rounded()), ph = Int((H * scale).rounded())
    guard let ctx = CGContext(data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: pw, height: ph))
    ctx.interpolationQuality = .high
    ctx.setShouldSmoothFonts(true)
    // 变换按调用的逆序作用在页面坐标上：先挪到原点 → 旋转 → 平移回画布 → 缩放
    ctx.scaleBy(x: scale, y: scale)
    switch rot {
    case 90:  ctx.translateBy(x: 0, y: H); ctx.rotate(by: -.pi / 2)
    case 180: ctx.translateBy(x: W, y: H); ctx.rotate(by: .pi)
    case 270: ctx.translateBy(x: W, y: 0); ctx.rotate(by: .pi / 2)
    default: break
    }
    ctx.translateBy(x: -box.minX, y: -box.minY)
    ctx.clip(to: box)
    ctx.drawPDFPage(page)
    guard let img = ctx.makeImage() else { continue }
    let name = String(format: "p%03d.jpg", i)
    guard let dest = CGImageDestinationCreateWithURL(outDir.appendingPathComponent(name) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.84] as CFDictionary)
    if CGImageDestinationFinalize(dest) { items.append(["n": i, "file": name, "w": pw, "h": ph]) }
  }
}
let info: [String: Any] = ["pages": total, "rendered": items.count, "items": items]
let data = try JSONSerialization.data(withJSONObject: info)
try data.write(to: outDir.appendingPathComponent("pages.json"))
print("pages=\(total) rendered=\(items.count)")
