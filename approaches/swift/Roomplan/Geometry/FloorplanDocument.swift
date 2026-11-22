import Foundation

struct PlanPoint: Codable, Equatable {
  var x: Double
  var y: Double
}
struct PlanWall: Codable {
  var id: String
  var start: PlanPoint
  var end: PlanPoint
  var thickness_m: Double
  var height_m: Double
  var length_m: Double
}
struct PlanDoor: Codable {
  var id: String
  var wall_id: String
  var position_along_m: Double
  var width_m: Double
  var type: String
}
struct PlanWindow: Codable {
  var id: String
  var wall_id: String
  var position_along_m: Double
  var width_m: Double
  var sill_height_m: Double
}
struct PlanRoom: Codable {
  var id: String
  var name: String
  var type: String
  var width_m: Double
  var length_m: Double
  var height_m: Double
  var polygon: [[Double]]
  var walls: [String]
  var label_point: [Double]? = nil
}
struct PlanDimension: Codable {
  var id: String
  var start: PlanPoint
  var end: PlanPoint
  var label: String
}
struct FloorplanState: Codable {
  var walls: [PlanWall] = []
  var doors: [PlanDoor] = []
  var windows: [PlanWindow] = []
  var rooms: [PlanRoom] = []
  var dimensions: [PlanDimension] = []
  var total_area_m2: Double = 0
}
struct FloorplanDocument: Codable {
  var version: Int = 1
  var source: String = "roomplan"
  var floorplan: FloorplanState = .init()
  var warnings: [String] = []

  mutating func add(_ other: FloorplanDocument, roomName: String? = nil) {
    var incoming = other.floorplan
    if let roomName, !incoming.rooms.isEmpty { incoming.rooms[0].name = roomName }
    // Capture sessions may share exact wall geometry. Reuse the existing wall ID.
    var replacements: [String: (id: String, reversed: Bool)] = [:]
    for wall in incoming.walls {
      if let existing = floorplan.walls.first(where: { $0.id == wall.id || Self.sameWall($0, wall) }
      ) {
        replacements[wall.id] = (
          existing.id, hypot(existing.start.x - wall.end.x, existing.start.y - wall.end.y) < 0.05
        )
      } else {
        floorplan.walls.append(wall)
      }
    }
    incoming.rooms = incoming.rooms.map { room in
      var room = room
      room.walls = room.walls.map { replacements[$0]?.id ?? $0 }
      return room
    }
    incoming.doors = incoming.doors.map { door in
      var door = door
      if let match = replacements[door.wall_id] {
        if match.reversed, let wall = incoming.walls.first(where: { $0.id == door.wall_id }) {
          door.position_along_m = wall.length_m - door.position_along_m
        }
        door.wall_id = match.id
      }
      return door
    }
    incoming.windows = incoming.windows.map { window in
      var window = window
      if let match = replacements[window.wall_id] {
        if match.reversed, let wall = incoming.walls.first(where: { $0.id == window.wall_id }) {
          window.position_along_m = wall.length_m - window.position_along_m
        }
        window.wall_id = match.id
      }
      return window
    }
    floorplan.rooms += incoming.rooms
    for door in incoming.doors {
      if !floorplan.doors.contains(where: {
        $0.id == door.id
          || ($0.wall_id == door.wall_id && abs($0.position_along_m - door.position_along_m) < 0.05
            && abs($0.width_m - door.width_m) < 0.05)
      }) {
        floorplan.doors.append(door)
      }
    }
    for window in incoming.windows {
      if !floorplan.windows.contains(where: {
        $0.id == window.id
          || ($0.wall_id == window.wall_id
            && abs($0.position_along_m - window.position_along_m) < 0.05
            && abs($0.width_m - window.width_m) < 0.05)
      }) {
        floorplan.windows.append(window)
      }
    }
    floorplan.dimensions += incoming.dimensions
    floorplan.total_area_m2 = floorplan.rooms.reduce(0) { $0 + Self.area($1.polygon) }
    warnings += other.warnings
  }
  static func area(_ polygon: [[Double]]) -> Double {
    guard polygon.count >= 3, polygon.allSatisfy({ $0.count == 2 }) else { return 0 }
    return abs(
      polygon.indices.reduce(0.0) { sum, i in
        let a = polygon[i]
        let b = polygon[(i + 1) % polygon.count]
        return sum + a[0] * b[1] - b[0] * a[1]
      }) / 2
  }
  private static func sameWall(_ a: PlanWall, _ b: PlanWall) -> Bool {
    func close(_ p: PlanPoint, _ q: PlanPoint) -> Bool { hypot(p.x - q.x, p.y - q.y) < 0.05 }
    return (close(a.start, b.start) && close(a.end, b.end))
      || (close(a.start, b.end) && close(a.end, b.start))
  }
}
