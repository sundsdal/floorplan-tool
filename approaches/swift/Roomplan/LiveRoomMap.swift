import RoomPlan
import SwiftUI
import simd

struct LiveMapPoint: Codable, Sendable, Equatable {
    let x: Double
    let y: Double

    init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }
}

struct LiveMapLine: Codable, Identifiable, Sendable {
    let id: String
    let start: LiveMapPoint
    let end: LiveMapPoint
}

struct LiveMapRoom: Identifiable, Sendable {
    let id: String
    let label: String
    let position: LiveMapPoint
}

struct SpatialRoom: Codable, Sendable {
    let id: String
    let name: String
    let polygon: [LiveMapPoint]

    func contains(_ point: LiveMapPoint) -> Bool {
        guard polygon.count >= 3 else { return false }
        var inside = false
        var previous = polygon.count - 1
        for index in polygon.indices {
            let a = polygon[index]
            let b = polygon[previous]
            let dx = b.x - a.x
            let dy = b.y - a.y
            let lengthSquared = dx * dx + dy * dy
            if lengthSquared > 0 {
                let fraction = max(0, min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
                let distance = hypot(point.x - (a.x + fraction * dx), point.y - (a.y + fraction * dy))
                if distance < 0.05 { return false }
            }
            if (a.y > point.y) != (b.y > point.y),
               point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x {
                inside.toggle()
            }
            previous = index
        }
        return inside
    }
}

// Only an unambiguous interior match is reliable enough to identify a revisit.
func knownRoom(at point: LiveMapPoint, in rooms: [SpatialRoom]) -> SpatialRoom? {
    let matches = rooms.filter { $0.contains(point) }
    return matches.count == 1 ? matches[0] : nil
}

func crossedDoor(previous: Double, current: Double) -> Bool {
    abs(previous) > 0.3 && abs(current) > 0.3 && previous * current < 0
}

struct LiveMapSnapshot: Sendable {
    var walls: [LiveMapLine] = []
    var doors: [LiveMapLine] = []
    var windows: [LiveMapLine] = []
    var labels: [LiveMapRoom] = []
    var rooms: [SpatialRoom] = []

    init() {}

    init(_ room: CapturedRoom, roomID: String? = nil, name: String? = nil) {
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
        if let roomID, let name {
            let floors = room.floors.map { floor in
                floor.polygonCorners.map { corner in
                    let point = floor.transform * SIMD4<Float>(corner.x, corner.y, corner.z, 1)
                    return LiveMapPoint(Double(point.x), Double(point.z))
                }
            }.filter { $0.count >= 3 && $0.allSatisfy { $0.x.isFinite && $0.y.isFinite } }
            if let polygon = floors.max(by: { area($0) < area($1) }), area(polygon) > 0.001 {
                rooms = [SpatialRoom(id: roomID.lowercased(), name: name, polygon: polygon)]
            }
        }
    }

    mutating func add(_ room: CapturedRoom, name: String, roomID: String? = nil) {
        let snapshot = LiveMapSnapshot(room, roomID: roomID ?? room.identifier.uuidString, name: name)
        walls.append(contentsOf: snapshot.walls)
        doors.append(contentsOf: snapshot.doors)
        windows.append(contentsOf: snapshot.windows)
        rooms.append(contentsOf: snapshot.rooms)
        let points = snapshot.walls.flatMap { [$0.start, $0.end] }
        if !points.isEmpty {
            labels.append(LiveMapRoom(
                id: (roomID ?? room.identifier.uuidString).lowercased(),
                label: name,
                position: LiveMapPoint(
                    points.map(\.x).reduce(0, +) / Double(points.count),
                    points.map(\.y).reduce(0, +) / Double(points.count)
                )
            ))
        }
    }
}

private func area(_ points: [LiveMapPoint]) -> Double {
    abs(points.indices.reduce(0.0) { sum, index in
        let next = points[(index + 1) % points.count]
        return sum + points[index].x * next.y - next.x * points[index].y
    }) / 2
}

struct LiveCameraPose: Sendable {
    let position: LiveMapPoint
    let forward: LiveMapPoint
}

struct LiveRoomMap: View {
    let snapshot: LiveMapSnapshot
    let camera: LiveCameraPose?
    var destinationRoomID: String? = nil

    var body: some View {
        GeometryReader { geometry in
            Canvas { context, size in
                let points = snapshot.walls.flatMap { [$0.start, $0.end] }
                    + snapshot.labels.map(\.position)
                    + snapshot.rooms.flatMap(\.polygon)
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
                for room in snapshot.rooms where room.id.lowercased() == destinationRoomID?.lowercased() {
                    guard let first = room.polygon.first else { continue }
                    var path = Path()
                    path.move(to: project(first))
                    for point in room.polygon.dropFirst() { path.addLine(to: project(point)) }
                    path.closeSubpath()
                    context.fill(path, with: .color(.orange.opacity(0.3)))
                    context.stroke(path, with: .color(.orange), lineWidth: 2)
                }
                stroke(snapshot.walls, color: .white, width: 3)
                stroke(snapshot.doors, color: .mint, width: 4)
                stroke(snapshot.windows, color: .cyan, width: 4)
                for label in snapshot.labels {
                    if label.id.lowercased() == destinationRoomID?.lowercased() {
                        let point = project(label.position)
                        context.fill(Path(ellipseIn: CGRect(x: point.x - 9, y: point.y - 9, width: 18, height: 18)), with: .color(.orange))
                    }
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
