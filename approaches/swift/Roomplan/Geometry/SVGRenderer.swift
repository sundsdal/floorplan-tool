import Foundation

enum SVGRenderer {
  static func render(document: FloorplanDocument) -> String {
    let plan = document.floorplan
    let points =
      plan.walls.flatMap { [$0.start, $0.end] }
      + plan.rooms.flatMap {
        $0.polygon.compactMap { $0.count == 2 ? PlanPoint(x: $0[0], y: $0[1]) : nil }
      }
    let minX = points.map(\.x).min() ?? 0
    let minY = points.map(\.y).min() ?? 0
    let maxX = points.map(\.x).max() ?? 1
    let maxY = points.map(\.y).max() ?? 1
    let scale = 50.0
    let margin = 45.0
    func number(_ n: Double) -> String {
      String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), n)
    }
    func x(_ n: Double) -> String { number((n - minX) * scale + margin) }
    func y(_ n: Double) -> String { number((n - minY) * scale + margin) }
    func escape(_ s: String) -> String {
      s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&apos;")
    }
    var lines = [
      "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 \(number((maxX-minX)*scale+2*margin)) \(number((maxY-minY)*scale+2*margin))\" data-source=\"\(escape(document.source))\">",
      "<title>Floor plan (\(escape(document.source)))</title>",
    ]
    for room in plan.rooms where room.polygon.count >= 3 {
      let vertices = room.polygon.filter { $0.count == 2 }
      guard vertices.count >= 3 else { continue }
      lines.append(
        "<polygon points=\"\(vertices.map { "\(x($0[0])),\(y($0[1]))" }.joined(separator: " "))\" fill=\"#e5e7eb\"/>"
      )
      let cx = vertices.reduce(0) { $0 + $1[0] } / Double(vertices.count)
      let cy = vertices.reduce(0) { $0 + $1[1] } / Double(vertices.count)
      lines.append(
        "<text x=\"\(x(cx))\" y=\"\(y(cy))\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"12\">\(escape(room.name))</text>"
      )
    }
    lines.append(
      "<text x=\"10\" y=\"18\" font-family=\"sans-serif\" font-size=\"12\">\(document.source == "roomplan" ? "LiDAR-derived dimensions" : "Video-derived dimensions")</text>"
    )
    for wall in plan.walls {
      lines.append(
        "<line x1=\"\(x(wall.start.x))\" y1=\"\(y(wall.start.y))\" x2=\"\(x(wall.end.x))\" y2=\"\(y(wall.end.y))\" stroke=\"#111827\" stroke-width=\"\(number(max(2, wall.thickness_m*scale)))\"/>"
      )
    }
    func opening(_ id: String, _ position: Double, _ width: Double, _ color: String) {
      guard let wall = plan.walls.first(where: { $0.id == id }), wall.length_m > 0 else { return }
      let dx = (wall.end.x - wall.start.x) / wall.length_m
      let dy = (wall.end.y - wall.start.y) / wall.length_m
      let a = max(0, position - width / 2)
      let b = min(wall.length_m, position + width / 2)
      guard b > a else { return }
      lines.append(
        "<line x1=\"\(x(wall.start.x+dx*a))\" y1=\"\(y(wall.start.y+dy*a))\" x2=\"\(x(wall.start.x+dx*b))\" y2=\"\(y(wall.start.y+dy*b))\" stroke=\"\(color)\" stroke-width=\"\(number(max(3,wall.thickness_m*scale+2)))\"/>"
      )
    }
    for wall in plan.walls {
      lines.append(
        "<text x=\"\(x((wall.start.x+wall.end.x)/2))\" y=\"\(y((wall.start.y+wall.end.y)/2))\" dy=\"-7\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"10\" fill=\"#374151\">\(number(wall.length_m)) m</text>"
      )
    }
    for door in plan.doors { opening(door.wall_id, door.position_along_m, door.width_m, "white") }
    for window in plan.windows {
      opening(window.wall_id, window.position_along_m, window.width_m, "#60a5fa")
    }
    lines.append("</svg>")
    return lines.joined(separator: "\n")
  }
}
