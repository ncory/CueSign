// Draws CueSign's icons from code, so they can be regenerated without a design tool:
//   swift tools/make-icons.swift
// Writes the menu bar / tray glyphs, the macOS .icns and the Windows .ico into app/Assets.
//
// The glyph is two overlapping screens with a "go" triangle, designed on an 18 x 18 grid.

import AppKit

let assets = URL(fileURLWithPath: "app/Assets")

func context(_ size: Int) -> CGContext {
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    // Flip to a top-left origin so the coordinates below match the design grid.
    ctx.translateBy(x: 0, y: CGFloat(size))
    ctx.scaleBy(x: 1, y: -1)
    return ctx
}

func png(_ ctx: CGContext) -> Data {
    NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
}

/// The glyph on its 18-unit grid. `solid` fills the front screen and knocks the triangle out of it.
func drawGlyph(_ ctx: CGContext, color: CGColor, solid: Bool, weight: CGFloat = 1.5) {
    ctx.setStrokeColor(color)
    ctx.setFillColor(color)
    ctx.setLineWidth(weight)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)

    // Back screen: only the part not hidden by the front one.
    let back = CGMutablePath()
    back.move(to: CGPoint(x: 5.5, y: 5.6))
    back.addLine(to: CGPoint(x: 5.5, y: 4.25))
    back.addArc(tangent1End: CGPoint(x: 5.5, y: 2.25), tangent2End: CGPoint(x: 7.5, y: 2.25), radius: 2)
    back.addLine(to: CGPoint(x: 14.25, y: 2.25))
    back.addArc(tangent1End: CGPoint(x: 16.25, y: 2.25), tangent2End: CGPoint(x: 16.25, y: 4.25), radius: 2)
    back.addLine(to: CGPoint(x: 16.25, y: 9.25))
    back.addArc(tangent1End: CGPoint(x: 16.25, y: 11.25), tangent2End: CGPoint(x: 14.25, y: 11.25), radius: 2)
    back.addLine(to: CGPoint(x: 13.6, y: 11.25))
    ctx.addPath(back)
    ctx.strokePath()

    let front = CGRect(x: 1.75, y: 6.25, width: 11.5, height: 9)
    let triangle = CGMutablePath()
    triangle.move(to: CGPoint(x: 6, y: 8.8))
    triangle.addLine(to: CGPoint(x: 9.6, y: 10.75))
    triangle.addLine(to: CGPoint(x: 6, y: 12.7))
    triangle.closeSubpath()

    if solid {
        let half = weight / 2
        ctx.addPath(CGPath(roundedRect: front.insetBy(dx: -half, dy: -half), cornerWidth: 2 + half, cornerHeight: 2 + half, transform: nil))
        ctx.fillPath()
        ctx.setBlendMode(.clear)
        ctx.addPath(triangle)
        ctx.fillPath()
        ctx.setBlendMode(.normal)
    } else {
        ctx.addPath(CGPath(roundedRect: front, cornerWidth: 2, cornerHeight: 2, transform: nil))
        ctx.strokePath()
        ctx.addPath(triangle)
        ctx.fillPath()
    }
}

/// Black-on-transparent glyph. macOS treats it as a template and tints it for the menu bar.
func trayGlyph(size: Int, solid: Bool) -> Data {
    let ctx = context(size)
    ctx.scaleBy(x: CGFloat(size) / 18, y: CGFloat(size) / 18)
    drawGlyph(ctx, color: .black, solid: solid)
    return png(ctx)
}

/// White glyph on a blue rounded square. `margin` is the transparent border as a fraction of the size.
func appIcon(size: Int, margin: CGFloat) -> Data {
    let ctx = context(size)
    let s = CGFloat(size)
    let tile = CGRect(x: s * margin, y: s * margin, width: s * (1 - 2 * margin), height: s * (1 - 2 * margin))
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: tile, cornerWidth: tile.width * 0.225, cornerHeight: tile.width * 0.225, transform: nil))
    ctx.clip()
    let colors = [CGColor(srgbRed: 0.36, green: 0.64, blue: 1.0, alpha: 1), CGColor(srgbRed: 0.16, green: 0.40, blue: 0.86, alpha: 1)] as CFArray
    let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: colors, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: tile.minY), end: CGPoint(x: 0, y: tile.maxY), options: [])
    ctx.restoreGState()

    // The glyph fills about two thirds of the tile. Small sizes get a heavier line to stay legible.
    let scale = tile.width * 0.66 / 18
    ctx.translateBy(x: tile.midX - 9 * scale, y: tile.midY - 9 * scale + scale * 0.1)
    ctx.scaleBy(x: scale, y: scale)
    drawGlyph(ctx, color: .white, solid: false, weight: size <= 32 ? 2.0 : 1.6)
    return png(ctx)
}

try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)

// Menu bar and tray glyphs: hollow while no players are online, solid once any are.
try trayGlyph(size: 72, solid: false).write(to: assets.appendingPathComponent("tray-idle.png"))
try trayGlyph(size: 72, solid: true).write(to: assets.appendingPathComponent("tray-active.png"))

// macOS app icon. Apple's grid leaves about a tenth of the canvas clear on every side.
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("CueSign.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    try appIcon(size: points, margin: 0.1).write(to: iconset.appendingPathComponent("icon_\(points)x\(points).png"))
    try appIcon(size: points * 2, margin: 0.1).write(to: iconset.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", assets.appendingPathComponent("CueSign.icns").path]
try iconutil.run()
iconutil.waitUntilExit()

// Windows icon: an .ico is a small directory followed by one PNG per size. Windows icons run edge to edge.
let sizes = [16, 24, 32, 48, 64, 256]
let images = sizes.map { appIcon(size: $0, margin: 0.02) }
var ico = Data([0, 0, 1, 0, UInt8(sizes.count), 0])
var offset = 6 + 16 * sizes.count
func le<T: FixedWidthInteger>(_ value: T) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
for (size, image) in zip(sizes, images) {
    let dimension = UInt8(size == 256 ? 0 : size) // 0 means 256
    ico.append(contentsOf: [dimension, dimension, 0, 0])
    ico.append(le(UInt16(1)))
    ico.append(le(UInt16(32)))
    ico.append(le(UInt32(image.count)))
    ico.append(le(UInt32(offset)))
    offset += image.count
}
images.forEach { ico.append($0) }
try ico.write(to: assets.appendingPathComponent("CueSign.ico"))

// A large preview for documentation and for checking the design by eye.
try appIcon(size: 512, margin: 0.1).write(to: assets.appendingPathComponent("CueSign.png"))
print("Icons written to \(assets.path)")
