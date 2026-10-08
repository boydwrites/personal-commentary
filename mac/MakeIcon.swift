import AppKit

// Renders the app icon: the book mark on a paper tile, at every size an .iconset needs.
// Usage: swift MakeIcon.swift <mark.svg> <output.iconset>
let mark = NSImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))!
let destination = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let paper = NSColor(srgbRed: 0xfa / 255, green: 0xf3 / 255, blue: 0xe6 / 255, alpha: 1)
let edge = NSColor(srgbRed: 0x2b / 255, green: 0x2a / 255, blue: 0x33 / 255, alpha: 0.10)

// A continuous corner curve fits macOS app tiles better than circular corners.
func tile(_ rect: NSRect) -> NSBezierPath {
    let shape = NSBezierPath()
    let corner = rect.width * 0.225, control = corner * 0.44
    let x = rect.minX, y = rect.minY, right = rect.maxX, top = rect.maxY
    shape.move(to: NSPoint(x: x + corner, y: y))
    shape.line(to: NSPoint(x: right - corner, y: y))
    shape.curve(to: NSPoint(x: right, y: y + corner), controlPoint1: NSPoint(x: right - control, y: y), controlPoint2: NSPoint(x: right, y: y + control))
    shape.line(to: NSPoint(x: right, y: top - corner))
    shape.curve(to: NSPoint(x: right - corner, y: top), controlPoint1: NSPoint(x: right, y: top - control), controlPoint2: NSPoint(x: right - control, y: top))
    shape.line(to: NSPoint(x: x + corner, y: top))
    shape.curve(to: NSPoint(x: x, y: top - corner), controlPoint1: NSPoint(x: x + control, y: top), controlPoint2: NSPoint(x: x, y: top - control))
    shape.line(to: NSPoint(x: x, y: y + corner))
    shape.curve(to: NSPoint(x: x + corner, y: y), controlPoint1: NSPoint(x: x, y: y + control), controlPoint2: NSPoint(x: x + control, y: y))
    shape.close()
    return shape
}

func render(_ pixels: Int, to file: URL) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let canvas = CGFloat(pixels)
    // macOS icon grid: an 824/1024 tile centered on the canvas.
    let frame = NSRect(x: canvas * 0.09765625, y: canvas * 0.09765625, width: canvas * 0.8046875, height: canvas * 0.8046875)
    let shape = tile(frame)
    paper.setFill(); shape.fill()
    edge.setStroke(); shape.lineWidth = max(1, canvas / 512); shape.stroke()
    let size = frame.width * 0.8
    mark.draw(in: NSRect(x: frame.midX - size / 2, y: frame.midY - size / 2, width: size, height: size),
               from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: file)
}

try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        try render(size * scale, to: destination.appendingPathComponent("icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"))
    }
}
