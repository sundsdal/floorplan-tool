import RoomPlan
import SwiftUI
import simd

struct LiveMapPoint: Sendable {
    let x: Double
    let y: Double

    init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }
}

struct LiveMapLine: Identifiable, Sendable {
    let id: String
    let start: LiveMapPoint
    let end: LiveMapPoint
}

struct LiveMapRoom: Identifiable, Sendable {
    let id: String
    let label: String
    let position: LiveMapPoint
}

struct LiveMapSnapshot: Sendable {
    var walls: [LiveMapLine] = []
    var doors: [LiveMapLine] = []
    var windows: [LiveMapLine] = []
    var labels: [LiveMapRoom] = []

    init() {}

    init(_ room: CapturedRoom) {
        func lines(_ surfaces: [CapturedRoom.Surface]) -> [LiveMapLine] {
            surfaces.compactMap { surface in
                let halfWidth = surface.dimensions.x / 2
                guard halfWidth.isFinite, halfWidth > 0 else { return nil }
                let a = surface.transform * SIMD4<Float>(-halfWidth, 0, 0, 1)
                let b = surface.transform * SIMD4<Float>(halfWidth, 0, 0, 1)
                guard a.x.isFinite, a.z.isFinite, b.x.isFinite, b.z.isFinite else { return nil }
                return LiveMapLine(
                    id: surface.identifier.uuidString,
                    start: LiveMapPoint(Double(a.x), Double(a.z)),
                    end: LiveMapPoint(Double(b.x), Double(b.z))
                )
            }
        }
        walls = lines(room.walls)
        doors = lines(room.doors + room.openings)
        windows = lines(room.windows)
    }

    mutating func add(_ room: CapturedRoom, name: String) {
        let snapshot = LiveMapSnapshot(room)
        walls.append(contentsOf: snapshot.walls)
        doors.append(contentsOf: snapshot.doors)
        windows.append(contentsOf: snapshot.windows)
        let points = snapshot.walls.flatMap { [$0.start, $0.end] }
        if !points.isEmpty {
            labels.append(LiveMapRoom(
                id: room.identifier.uuidString,
                label: name,
                position: LiveMapPoint(
                    points.map(\.x).reduce(0, +) / Double(points.count),
                    points.map(\.y).reduce(0, +) / Double(points.count)
                )
            ))
        }
    }
}

struct LiveCameraPose: Sendable {
    let position: LiveMapPoint
    let forward: LiveMapPoint
}

struct LiveRoomMap: View {
    let snapshot: LiveMapSnapshot
    let camera: LiveCameraPose?

    var body: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                let points = snapshot.walls.flatMap { [$0.start, $0.end] }
                    + (camera.map { [$0.position] } ?? [])
                guard !points.isEmpty else { return }
                let minX = points.map(\.x).min() ?? 0
                let maxX = points.map(\.x).max() ?? 0
                let minY = points.map(\.y).min() ?? 0
                let maxY = points.map(\.y).max() ?? 0
                let spanX = max(maxX - minX, 1)
                let spanY = max(maxY - minY, 1)
                let scale = min((size.width - 32) / spanX, (size.height - 32) / spanY)
                let centerX = (minX + maxX) / 2
                let centerY = (minY + maxY) / 2
                func project(_ point: LiveMapPoint) -> CGPoint {
                    CGPoint(
                        x: size.width / 2 + (point.x - centerX) * scale,
                        y: size.height / 2 + (point.y - centerY) * scale
                    )
                }
                func stroke(_ lines: [LiveMapLine], color: Color, width: CGFloat) {
                    var path = Path()
                    for line in lines {
                        path.move(to: project(line.start))
                        path.addLine(to: project(line.end))
                    }
                    context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round))
                }
                stroke(snapshot.walls, color: .white, width: 3)
                stroke(snapshot.doors, color: .mint, width: 4)
                stroke(snapshot.windows, color: .cyan, width: 4)
                for label in snapshot.labels {
                    context.draw(
                        Text(label.label).font(.caption2.weight(.semibold)).foregroundStyle(.white),
                        at: project(label.position)
                    )
                }
                if let camera {
                    let point = project(camera.position)
                    let length = hypot(camera.forward.x, camera.forward.y)
                    if length > 0.001 {
                        let dx = camera.forward.x / length
                        let dy = camera.forward.y / length
                        let tip = CGPoint(x: point.x + dx * 14, y: point.y + dy * 14)
                        let left = CGPoint(x: point.x - dx * 6 - dy * 5, y: point.y - dy * 6 + dx * 5)
                        let right = CGPoint(x: point.x - dx * 6 + dy * 5, y: point.y - dy * 6 - dx * 5)
                        var arrow = Path()
                        arrow.move(to: tip)
                        arrow.addLine(to: left)
                        arrow.addLine(to: right)
                        arrow.closeSubpath()
                        context.fill(arrow, with: .color(.mint))
                        context.stroke(arrow, with: .color(.black.opacity(0.7)), lineWidth: 1)
                    } else {
                        context.fill(Path(ellipseIn: CGRect(x: point.x - 4, y: point.y - 4, width: 8, height: 8)), with: .color(.mint))
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Live floor plan showing your position and direction")
    }
}
