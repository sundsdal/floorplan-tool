import Foundation
import XCTest

@testable import Roomplan

final class GeometryTests: XCTestCase {
  func testSharedRotatedFixtureAndSVG() throws {
    let fixture = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "rotated-l", withExtension: "json"))
    let document = try JSONDecoder().decode(FloorplanDocument.self, from: Data(contentsOf: fixture))
    XCTAssertEqual(document.version, 1)
    XCTAssertEqual(document.source, "roomplan")
    XCTAssertEqual(
      FloorplanDocument.area(document.floorplan.rooms[0].polygon), 12, accuracy: 0.0001)
    let roundTrip = try JSONDecoder().decode(
      FloorplanDocument.self, from: JSONEncoder().encode(document))
    XCTAssertEqual(roundTrip.floorplan.walls.count, 6)
    let svg = SVGRenderer.render(document: roundTrip)
    XCTAssertTrue(svg.contains("data-source=\"roomplan\""))
    XCTAssertTrue(svg.contains("Studio"))
    XCTAssertTrue(svg.contains("<polygon"))
  }
  func testRotatedWallOnlyBoundaryDimensions() {
    let c = sqrt(0.5)
    let polygon = [[0.0, 0.0], [4 * c, 4 * c], [2 * c, 6 * c], [-2 * c, 2 * c]]
    let wall = PlanWall(
      id: "wall", start: .init(x: 0, y: 0), end: .init(x: 4 * c, y: 4 * c),
      thickness_m: 0.1, height_m: 2.4, length_m: 4)
    let (width, length) = RoomPlanConverter.dimensions(of: polygon, alignedWith: wall)
    XCTAssertEqual(width, 4, accuracy: 0.0001)
    XCTAssertEqual(length, 2, accuracy: 0.0001)
    XCTAssertEqual(FloorplanDocument.area(polygon), 8, accuracy: 0.0001)
  }
  func testReversedSharedWallPreservesOpeningPosition() {
    let wall = PlanWall(
      id: "a", start: .init(x: 0, y: 0), end: .init(x: 4, y: 0), thickness_m: 0.1, height_m: 2.4,
      length_m: 4)
    var first = FloorplanDocument()
    first.floorplan.walls = [wall]
    var second = FloorplanDocument()
    var reversed = wall
    reversed.id = "b"
    reversed.start = wall.end
    reversed.end = wall.start
    second.floorplan.walls = [reversed]
    second.floorplan.doors = [
      PlanDoor(id: "door", wall_id: "b", position_along_m: 1, width_m: 0.8, type: "standard")
    ]
    first.add(second)
    XCTAssertEqual(first.floorplan.walls.count, 1)
    XCTAssertEqual(first.floorplan.doors[0].wall_id, "a")
    XCTAssertEqual(first.floorplan.doors[0].position_along_m, 3)
  }
  func testSharedOpeningsAndStableWallIDsAreDeduplicated() {
    let wall = PlanWall(
      id: "wall", start: .init(x: 0, y: 0), end: .init(x: 4, y: 0), thickness_m: 0.1, height_m: 2.4,
      length_m: 4)
    var first = FloorplanDocument()
    first.floorplan.walls = [wall]
    first.floorplan.doors = [
      PlanDoor(id: "d1", wall_id: "wall", position_along_m: 1, width_m: 0.8, type: "standard")
    ]
    first.floorplan.windows = [
      PlanWindow(id: "w1", wall_id: "wall", position_along_m: 2, width_m: 1, sill_height_m: 0.8)
    ]
    var second = FloorplanDocument()
    var reverse = wall
    reverse.start = wall.end
    reverse.end = wall.start
    second.floorplan.walls = [reverse]
    second.floorplan.doors = [
      PlanDoor(id: "d2", wall_id: "wall", position_along_m: 3.01, width_m: 0.81, type: "standard")
    ]
    second.floorplan.windows = [
      PlanWindow(
        id: "w2", wall_id: "wall", position_along_m: 2.01, width_m: 1.01, sill_height_m: 0.8)
    ]
    first.add(second)
    XCTAssertEqual(first.floorplan.walls.count, 1)
    XCTAssertEqual(first.floorplan.doors.count, 1)
    XCTAssertEqual(first.floorplan.windows.count, 1)
  }
}
