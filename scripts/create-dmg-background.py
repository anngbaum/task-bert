#!/usr/bin/env python3
"""Generate the DMG background image with arrow and installation instructions.
Renders at 2x for Retina sharpness."""

import subprocess
import sys
import os
import tempfile

SCALE = 2
WIDTH = 660 * SCALE
HEIGHT = 400 * SCALE  # Shorter window to reduce dead space
OUTPUT = os.path.join(os.path.dirname(__file__), '..', 'build', 'dmg-background.png')

os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)

# Layout (in logical 1x coords, top-down):
#   Icons at y=80 from top (set via AppleScript)
#   Icon height ~80 + label ~15 = bottom of icons at ~175
#   Arrow at y=120 from top (vertically centered with icons)
#   Instructions box: top at y=210, height=120, bottom at y=330
#   Window height: 400

swift_code = f"""
import Cocoa

let scale = {SCALE}
let width = {WIDTH}
let height = {HEIGHT}
let s = CGFloat(scale)
let outputPath = CommandLine.arguments[1]

let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(
    data: nil, width: width, height: height,
    bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {{ exit(1) }}

// Background
ctx.setFillColor(CGColor(red: 0.96, green: 0.96, blue: 0.95, alpha: 1.0))
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

// Arrow at y=80 from top → CG y = height - 80*s (centered with icons)
let arrowY = CGFloat(height) - 80.0 * s
let arrowStartX = 230.0 * s
let arrowEndX = 430.0 * s

ctx.setStrokeColor(CGColor(red: 0.45, green: 0.45, blue: 0.45, alpha: 0.7))
ctx.setLineWidth(3.0 * s)
ctx.setLineCap(.round)

ctx.move(to: CGPoint(x: arrowStartX, y: arrowY))
ctx.addLine(to: CGPoint(x: arrowEndX, y: arrowY))
ctx.strokePath()

let headSize = 14.0 * s
ctx.move(to: CGPoint(x: arrowEndX - headSize, y: arrowY + headSize))
ctx.addLine(to: CGPoint(x: arrowEndX, y: arrowY))
ctx.addLine(to: CGPoint(x: arrowEndX - headSize, y: arrowY - headSize))
ctx.strokePath()

// --- Instructions box ---
// Top at y=210 from top → CG bottom = height - 210*s - boxHeight
let boxHeight = 120.0 * s
let boxBottom = CGFloat(height) - 210.0 * s - boxHeight
let boxRect = NSRect(x: 30 * s, y: boxBottom, width: CGFloat(width) - 60 * s, height: boxHeight)

let nsCtx = NSGraphicsContext(cgContext: ctx, flipped: false)
NSGraphicsContext.current = nsCtx

let boxPath = NSBezierPath(roundedRect: boxRect, xRadius: 10 * s, yRadius: 10 * s)
NSColor(red: 0.95, green: 0.92, blue: 0.85, alpha: 1.0).setFill()
boxPath.fill()
NSColor(red: 0.85, green: 0.78, blue: 0.65, alpha: 1.0).setStroke()
boxPath.lineWidth = 1.5 * s
boxPath.stroke()

// Title — positioned relative to box top
let titleY = boxBottom + boxHeight - 32 * s
let titleAttrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.boldSystemFont(ofSize: 12 * s),
    .foregroundColor: NSColor(red: 0.55, green: 0.35, blue: 0.0, alpha: 1.0)
]
("IMPORTANT INSTALLATION INSTRUCTIONS" as NSString).draw(
    at: NSPoint(x: 48 * s, y: titleY), withAttributes: titleAttrs)

// Body lines
let bodyAttrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 11 * s),
    .foregroundColor: NSColor(red: 0.3, green: 0.3, blue: 0.3, alpha: 1.0)
]
let lines: [(String, CGFloat)] = [
    ("OpenSearch will be blocked the first time you open it.", titleY - 26 * s),
    ("After you try to open it, go to System Settings \\u{{2192}} Privacy & Security,", titleY - 52 * s),
    ("scroll down, and click \\u{{201C}}Open Anyway\\u{{201D}} next to the message about OpenSearch.", titleY - 70 * s),
]
for (text, y) in lines {{
    (text as NSString).draw(at: NSPoint(x: 48 * s, y: y), withAttributes: bodyAttrs)
}}

NSGraphicsContext.current = nil

guard let image = ctx.makeImage() else {{ exit(1) }}
let url = URL(fileURLWithPath: outputPath) as CFURL
guard let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil) else {{ exit(1) }}

let properties: [CFString: Any] = [
    kCGImagePropertyDPIWidth: 72 * scale,
    kCGImagePropertyDPIHeight: 72 * scale
]
CGImageDestinationAddImage(dest, image, properties as CFDictionary)
CGImageDestinationFinalize(dest)
print("Created background: \\(outputPath) (\\(width)x\\(height) @\\(scale)x)")
"""

with tempfile.NamedTemporaryFile(mode='w', suffix='.swift', delete=False) as f:
    f.write(swift_code)
    swift_path = f.name

try:
    result = subprocess.run(
        ['swift', swift_path, os.path.abspath(OUTPUT)],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"Swift failed:\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    print(result.stdout.strip())
finally:
    os.unlink(swift_path)
