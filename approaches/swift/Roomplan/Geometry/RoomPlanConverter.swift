import Foundation
import RoomPlan
import simd

enum RoomPlanConverter {
  static func dimensions(of polygon: [[Double]], alignedWith wall: PlanWall?) -> (Double, Double) {
    let dx = wall.map { ($0.end.x - $0.start.x) / $0.length_m } ?? 1
    let dy = wall.map { ($0.end.y - $0.start.y) / $0.length_m } ?? 0
    let along = polygon.map { $0[0] * dx + $0[1] * dy }
    let across = polygon.map { -$0[0] * dy + $0[1] * dx }
    return ((along.max() ?? 0) - (along.min() ?? 0), (across.max() ?? 0) - (across.min() ?? 0))
  }

  static func convert(_ room: CapturedRoom) -> FloorplanDocument {
    var doc = FloorplanDocument()
    func point(_ surface: CapturedRoom.Surface, _ localX: Float) -> PlanPoint {
      let p = surface.transform * SIMD4<Float>(localX, 0, 0, 1)
      return PlanPoint(x: Double(p.x), y: Double(p.z))
    }
    for surface in room.walls {
      let start = point(surface, -surface.dimensions.x / 2)
      let end = point(surface, surface.dimensions.x / 2)
      guard start.x.isFinite, start.y.isFinite, end.x.isFinite, end.y.isFinite,
        surface.dimensions.y.isFinite, surface.dimensions.y > 0,
        hypot(end.x - start.x, end.y - start.y) > 0.001
      else {
        doc.warnings.append("A wall with missing or invalid measurements was omitted.")
        continue
      }
      doc.floorplan.walls.append(
        PlanWall(
          id: surface.identifier.uuidString, start: start, end: end, thickness_m: 0.1,
          height_m: Double(surface.dimensions.y), length_m: hypot(end.x - start.x, end.y - start.y))
      )
    }
    func nearest(_ surface: CapturedRoom.Surface) -> (PlanWall, Double)? {
      let p = point(surface, 0)
      if let parent = surface.parentIdentifier,
        let wall = doc.floorplan.walls.first(where: { $0.id == parent.uuidString }),
        wall.length_m > 0
      {
        let dx = wall.end.x - wall.start.x
        let dy = wall.end.y - wall.start.y
        let projection = ((p.x - wall.start.x) * dx + (p.y - wall.start.y) * dy) / wall.length_m
        return (wall, max(0, min(wall.length_m, projection)))
      }
      return doc.floorplan.walls.compactMap { wall -> (PlanWall, Double, Double)? in
        let dx = wall.end.x - wall.start.x
        let dy = wall.end.y - wall.start.y
        let len2 = dx * dx + dy * dy
        guard len2 > 0 else { return nil }
        let t = max(0, min(1, ((p.x - wall.start.x) * dx + (p.y - wall.start.y) * dy) / len2))
        return (
          wall, t * sqrt(len2), hypot(p.x - (wall.start.x + t * dx), p.y - (wall.start.y + t * dy))
        )
      }.filter { $0.2 < 0.3 }.min { $0.2 < $1.2 }.map { ($0.0, $0.1) }
    }
    for surface in room.doors + room.openings {
      guard surface.dimensions.x.isFinite, surface.dimensions.x > 0 else {
        doc.warnings.append("An opening with missing width was omitted.")
        continue
      }
      if let (wall, position) = nearest(surface) {
        doc.floorplan.doors.append(
          PlanDoor(
            id: surface.identifier.uuidString, wall_id: wall.id, position_along_m: position,
            width_m: Double(surface.dimensions.x),
            type: room.openings.contains(where: { $0.identifier == surface.identifier })
              ? "opening" : "standard"))
      } else {
        doc.warnings.append("An opening could not be matched to a wall.")
      }
    }
    for surface in room.windows {
      guard surface.dimensions.x.isFinite, surface.dimensions.x > 0, surface.dimensions.y.isFinite,
        surface.transform.columns.3.y.isFinite
      else {
        doc.warnings.append("A window with missing measurements was omitted.")
        continue
      }
      guard !room.floors.isEmpty else {
        doc.warnings.append("A window was omitted because floor height is unavailable.")
        continue
      }
      if let (wall, position) = nearest(surface) {
        let floorHeight = room.floors.first.map { Double($0.transform.columns.3.y) } ?? 0
        let centerHeight = Double(surface.transform.columns.3.y) - floorHeight
        doc.floorplan.windows.append(
          PlanWindow(
            id: surface.identifier.uuidString, wall_id: wall.id, position_along_m: position,
            width_m: Double(surface.dimensions.x),
            sill_height_m: max(0, centerHeight - Double(surface.dimensions.y) / 2)))
      } else {
        doc.warnings.append("A window could not be matched to a wall.")
      }
    }
    // Trace a closed loop only when wall endpoints actually meet; never invent a boundary.
    var remaining = doc.floorplan.walls
    if room.floors.count > 1 {
      doc.warnings.append(
        "Multiple floor surfaces were detected; only the largest is used for this room.")
    }
    let floorPolygons = room.floors.map { floor in
      floor.polygonCorners.map { corner -> [Double] in
        let p = floor.transform * SIMD4<Float>(corner.x, corner.y, corner.z, 1)
        return [Double(p.x), Double(p.z)]
      }
    }.filter { $0.count >= 3 && FloorplanDocument.area($0) > 0.001 }
    if !doc.floorplan.walls.isEmpty,
      let floorPolygon = floorPolygons.max(by: {
        FloorplanDocument.area($0) < FloorplanDocument.area($1)
      })
    {
      let (width, length) = dimensions(
        of: floorPolygon, alignedWith: doc.floorplan.walls.first { $0.length_m > 0.001 })
      doc.floorplan.rooms = [
        PlanRoom(
          id: room.identifier.uuidString, name: "Room", type: "other",
          width_m: width, length_m: length,
          height_m: doc.floorplan.walls.map(\.height_m).max() ?? 0, polygon: floorPolygon,
          walls: doc.floorplan.walls.map(\.id))
      ]
      doc.floorplan.total_area_m2 = FloorplanDocument.area(floorPolygon)
      if doc.floorplan.walls.isEmpty {
        doc.warnings.append("No walls were captured; room boundaries are incomplete.")
      }
      return doc
    }
    var polygon: [[Double]] = []
    var ids: [String] = []
    if doc.floorplan.walls.isEmpty && !floorPolygons.isEmpty {
      doc.warnings.append("Room omitted because wall height is unavailable.")
    }
    if !remaining.isEmpty {
      let first = remaining.removeFirst()
      polygon = [[first.start.x, first.start.y]]
      ids = [first.id]
      var end = first.end
      while !remaining.isEmpty && hypot(end.x - polygon[0][0], end.y - polygon[0][1]) > 0.15 {
        polygon.append([end.x, end.y])
        guard
          let index = remaining.indices.min(by: { i, j in
            min(
              hypot(remaining[i].start.x - end.x, remaining[i].start.y - end.y),
              hypot(remaining[i].end.x - end.x, remaining[i].end.y - end.y))
              < min(
                hypot(remaining[j].start.x - end.x, remaining[j].start.y - end.y),
                hypot(remaining[j].end.x - end.x, remaining[j].end.y - end.y))
          })
        else { break }
        let wall = remaining[index]
        let a = hypot(wall.start.x - end.x, wall.start.y - end.y)
        let b = hypot(wall.end.x - end.x, wall.end.y - end.y)
        guard min(a, b) <= 0.15 else { break }
        remaining.remove(at: index)
        ids.append(wall.id)
        end = a <= b ? wall.end : wall.start
      }
      if polygon.count >= 3 && hypot(end.x - polygon[0][0], end.y - polygon[0][1]) <= 0.15 {
        let (width, length) = dimensions(of: polygon, alignedWith: first)
        doc.floorplan.rooms = [
          PlanRoom(
            id: room.identifier.uuidString, name: "Room", type: "other",
            width_m: width, length_m: length,
            height_m: doc.floorplan.walls.map(\.height_m).max() ?? 0, polygon: polygon, walls: ids)
        ]
        doc.floorplan.total_area_m2 = FloorplanDocument.area(polygon)
      } else {
        doc.warnings.append("Room boundary is incomplete; area could not be calculated.")
      }
      if !remaining.isEmpty {
        doc.warnings.append("Some walls were not included in the room boundary.")
      }
    } else {
      doc.warnings.append("No walls were captured; room boundary is incomplete.")
    }
    return doc
  }
}
