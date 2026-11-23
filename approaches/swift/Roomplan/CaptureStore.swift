import ARKit
import AVFoundation
import Foundation
import RoomPlan
import SwiftUI

struct SavedRoom: Identifiable, Codable {
    let id: UUID
    var name: String
    let createdAt: Date
    var sessionID: UUID? = nil
}

@MainActor
final class CaptureStore: NSObject, ObservableObject, RoomCaptureSessionDelegate {
    @Published var rooms: [SavedRoom] = []
    @Published var message: String?
    @Published var scanning = false
    @Published var processing = false
    @Published private(set) var evidenceCaptureInProgress = false
    @Published private(set) var inspectionFinalizationStarted = false
    @Published var instruction = "Move slowly around the room, keeping walls and openings in view."
    @Published private(set) var captureView: RoomCaptureView
    @Published private(set) var liveMap = LiveMapSnapshot()
    @Published private(set) var cameraPose: LiveCameraPose?
    @Published private(set) var annotationPending: Set<UUID> = []
    private var savedFloorMap = LiveMapSnapshot()
    private let frameSampler = RoomFrameSampler()
    private let directory: URL
    private var sessionID = UUID()
    private var trackingTask: Task<Void, Never>?
    var hasActiveFloor: Bool { rooms.contains { $0.sessionID == sessionID } }
    private var stopping = false
    private var scanGeneration = 0
    let inspection = InspectionGuide()
    private var inspectionRoomID: UUID?
    private var inspectionRoomName = ""
    private var segmentAnchor: LiveMapPoint?
    private var guideNamedRooms: [String: String] = [:]
    private var autoContinue = false
    private var submitAfterCapture = false
    var transitioningRooms: Bool { autoContinue && processing }
    private var segmentStarted = Date()
    private var doorSides: [String: Double] = [:]
    private var nextSegmentPosition: LiveMapPoint?
    private var revisitCandidate: (id: String, since: Date)?
    private var inspectionRooms: [(id: UUID, saved: SavedRoom)] = []
    private struct InspectionRoomRecord: Codable { let id: UUID; let saved: SavedRoom }
    var hasInspectionRooms: Bool { !inspectionRooms.isEmpty }

    override init() {
        let arSession = ARSession()
        captureView = RoomCaptureView(frame: .zero, arSession: arSession)
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appending(path: "RoomCaptures", directoryHint: .isDirectory)
        super.init()
        inspection.onRoomNamed = { [weak self] id, name in self?.renameInspectionRoom(id: id, name: name) }
        captureView.captureSession.delegate = self
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            rooms = try loadRooms()
        } catch { message = "Could not load saved rooms: \(error.localizedDescription)" }
    }

    var supported: Bool { RoomCaptureSession.isSupported }

    func start() async {
        guard !scanning, !processing, !inspection.busy, !inspectionFinalizationStarted else { return }
        guard supported else { message = "RoomPlan requires a supported iPhone or iPad with LiDAR."; return }
        let generation = scanGeneration
        let authorized = await AVCaptureDevice.requestAccess(for: .video)
        guard generation == scanGeneration, !scanning, !processing, !inspection.busy, !inspectionFinalizationStarted else { return }
        guard authorized else { message = "Allow camera access in Settings to scan a room."; return }
        stopping = false
        if inspection.link != nil {
            let position = nextSegmentPosition ?? cameraPose?.position
            nextSegmentPosition = nil
            let match = position.flatMap { knownRoom(at: $0, in: savedFloorMap.rooms) }
            let roomID = match.flatMap { UUID(uuidString: $0.id) } ?? UUID()
            inspectionRoomID = roomID
            let id = roomID.uuidString.lowercased()
            inspectionRoomName = guideNamedRooms[id] ?? match?.name ?? "Rom \(inspectionRooms.count + 1)"
            inspection.postEvent("room.upsert", roomID: id, data: ["name": inspectionRoomName])
            inspection.postEvent("room.visited", roomID: id, data: [:])
            inspection.announceRoom(id: id, name: inspectionRoomName, phase: "start")
            segmentStarted = .now
            segmentAnchor = position
            doorSides = [:]
            revisitCandidate = nil
        }
        frameSampler.reset()
        savedFloorMap = LiveMapSnapshot()
        for entry in rooms where entry.sessionID == sessionID {
            if inspection.link != nil && !inspectionRooms.contains(where: { $0.saved.id == entry.id }) { continue }
            if let room = try? capturedRoom(entry) {
                let id = inspectionRooms.first { $0.saved.id == entry.id }?.id.uuidString.lowercased()
                savedFloorMap.add(room, name: entry.name, roomID: id)
            }
        }
        liveMap = savedFloorMap
        cameraPose = nil
        scanning = true
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
        trackingTask?.cancel()
        trackingTask = Task {
            while !Task.isCancelled && (scanning || inspection.link != nil) {
                if let frame = captureView.captureSession.arSession.currentFrame,
                   ProcessInfo.processInfo.systemUptime - frame.timestamp < 2 {
                    switch frame.camera.trackingState {
                    case .limited(.relocalizing):
                        instruction = "Tracking is relocalizing. Return to a previously scanned area and move slowly."
                        cameraPose = nil
                    case .limited:
                        instruction = "Tracking is limited. Move slowly and point at a well-lit, detailed area."
                        cameraPose = nil
                    case .notAvailable:
                        instruction = "Tracking is unavailable. Return to a previously scanned area."
                        cameraPose = nil
                    case .normal:
                        let transform = frame.camera.transform
                        cameraPose = LiveCameraPose(
                            position: LiveMapPoint(Double(transform.columns.3.x), Double(transform.columns.3.z)),
                            forward: LiveMapPoint(-Double(transform.columns.2.x), -Double(transform.columns.2.z))
                        )
                        if inspection.link != nil, segmentAnchor == nil { segmentAnchor = cameraPose?.position }
                    }
                    if inspection.link != nil {
                        inspection.capture(frame.capturedImage)
                        let tracking: String
                        switch frame.camera.trackingState {
                        case .normal: tracking = "tracked"
                        case .limited: tracking = "uncertain"
                        case .notAvailable: tracking = "unavailable"
                        }
                        inspection.updateSpatial(snapshot: liveMap, pose: cameraPose, tracking: tracking)
                        if scanning, let pose = cameraPose { detectDoorCrossing(pose.position) }
                    }
                    if scanning && RoomAnnotationClient.shared.signedIn {
                        frameSampler.sample(frame.capturedImage)
                    }
                } else if inspection.link != nil {
                    cameraPose = nil
                    inspection.updateSpatial(snapshot: liveMap, pose: nil, tracking: "unavailable")
                }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
    }

    private func detectDoorCrossing(_ point: LiveMapPoint) {
        guard inspection.link != nil, !stopping, Date().timeIntervalSince(segmentStarted) > 8 else { return }
        if let known = knownRoom(at: point, in: savedFloorMap.rooms),
           known.id.lowercased() != inspectionRoomID?.uuidString.lowercased() {
            if revisitCandidate?.id != known.id { revisitCandidate = (known.id, .now) }
            if let candidate = revisitCandidate, Date().timeIntervalSince(candidate.since) >= 2 {
                autoContinue = true
                nextSegmentPosition = point
                finish()
                return
            }
        } else { revisitCandidate = nil }
        for door in liveMap.doors {
            let dx = door.end.x - door.start.x, dy = door.end.y - door.start.y
            let length = hypot(dx, dy)
            guard length > 0.4 else { continue }
            let along = ((point.x - door.start.x) * dx + (point.y - door.start.y) * dy) / (length * length)
            guard along > -0.3, along < 1.3 else { continue }
            let side = ((point.x - door.start.x) * dy - (point.y - door.start.y) * dx) / length
            guard abs(side) < 1.5 else { continue }
            if let previous = doorSides[door.id], crossedDoor(previous: previous, current: side) {
                autoContinue = true
                nextSegmentPosition = point
                finish()
                return
            }
            if abs(side) > 0.3 { doorSides[door.id] = side }
        }
    }

    func finishFromCamera() {
        guard scanning, !stopping else { return }
        submitAfterCapture = inspection.link != nil
        finish()
    }

    func finish() {
        guard scanning, !stopping else { return }
        stopping = true
        processing = true
        if inspection.link != nil {
            cameraPose = nil
            inspection.updateSpatial(snapshot: liveMap, pose: nil, tracking: "unavailable")
        }
        captureView.captureSession.stop(pauseARSession: false)
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        let sessionIdentity = ObjectIdentifier(session)
        let snapshot = LiveMapSnapshot(room, roomID: room.identifier.uuidString, name: "Room")
        Task { @MainActor [weak self] in
            guard let self, self.scanning,
                  ObjectIdentifier(self.captureView.captureSession) == sessionIdentity else { return }
            var combined = self.savedFloorMap
            combined.walls.append(contentsOf: snapshot.walls)
            combined.doors.append(contentsOf: snapshot.doors)
            combined.windows.append(contentsOf: snapshot.windows)
            if let id = self.inspectionRoomID {
                let activeRooms = snapshot.rooms.map {
                    SpatialRoom(id: id.uuidString.lowercased(), name: self.inspectionRoomName, polygon: $0.polygon)
                }
                combined.rooms.append(contentsOf: activeRooms)
                for room in activeRooms {
                    let count = Double(room.polygon.count)
                    combined.labels.append(LiveMapRoom(
                        id: room.id, label: room.name,
                        position: LiveMapPoint(room.polygon.map(\.x).reduce(0, +) / count,
                                               room.polygon.map(\.y).reduce(0, +) / count)
                    ))
                }
                if activeRooms.isEmpty, let anchor = self.segmentAnchor {
                    combined.labels.append(LiveMapRoom(id: id.uuidString.lowercased(), label: self.inspectionRoomName, position: anchor))
                }
            }
            self.liveMap = combined
        }
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
        let sessionIdentity = ObjectIdentifier(session)
        let text: String
        switch instruction {
        case .moveCloseToWall: text = "Move closer to the wall."
        case .moveAwayFromWall: text = "Move away from the wall."
        case .slowDown: text = "Move more slowly."
        case .turnOnLight: text = "Turn on more light."
        case .lowTexture: text = "Point at an area with more detail."
        default: text = "Move slowly around the room, keeping walls and openings in view."
        }
        Task { @MainActor [weak self] in
            guard let self, ObjectIdentifier(self.captureView.captureSession) == sessionIdentity else { return }
            self.instruction = text
        }
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: (any Error)?) {
        let sessionIdentity = ObjectIdentifier(session)
        let errorDescription = error?.localizedDescription
        Task { @MainActor [weak self] in
            guard let self, ObjectIdentifier(self.captureView.captureSession) == sessionIdentity else { return }
            self.scanning = false
            if self.inspection.link == nil { self.trackingTask?.cancel() }
            let frames = self.frameSampler.frames
            self.frameSampler.reset()
            if let errorDescription {
                self.submitAfterCapture = false
                self.autoContinue = false
                self.processing = false
                self.message = "Scan ended: \(errorDescription). Previously saved rooms are still available."
                return
            }
            self.processing = true
            do {
                let room = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
                var entry = try self.save(room)
                if let id = self.inspectionRoomID {
                    if let index = self.rooms.firstIndex(where: { $0.id == entry.id }) {
                        entry.name = self.inspectionRoomName
                        try JSONEncoder().encode(entry).write(to: self.roomDirectory(entry).appending(path: "info.json"), options: .atomic)
                        self.rooms[index] = entry
                    }
                    self.inspectionRooms.removeAll { $0.id == id }
                    self.inspectionRooms.append((id: id, saved: entry))
                    self.persistInspectionRooms()
                    self.savedFloorMap = LiveMapSnapshot()
                    for item in self.inspectionRooms where item.saved.sessionID == self.sessionID {
                        if let captured = try? self.capturedRoom(item.saved) {
                            let name = self.rooms.first(where: { $0.id == item.saved.id })?.name ?? item.saved.name
                            self.savedFloorMap.add(captured, name: name, roomID: item.id.uuidString.lowercased())
                        }
                    }
                    self.liveMap = self.savedFloorMap
                    self.inspection.announceRoom(id: id.uuidString.lowercased(), name: entry.name, phase: "finish")
                    var document = RoomPlanConverter.convert(room)
                    if !document.floorplan.rooms.isEmpty { document.floorplan.rooms[0].id = id.uuidString.lowercased() }
                    if let encoded = try? JSONEncoder().encode(document),
                       let object = try? JSONSerialization.jsonObject(with: encoded) {
                        self.inspection.postEvent("room.upsert", roomID: id.uuidString.lowercased(), data: ["name": entry.name, "document": object])
                    }
                    self.inspectionRoomID = nil
                }
                if RoomAnnotationClient.shared.signedIn && !frames.isEmpty {
                    self.annotationPending.insert(entry.id)
                    Task { await self.annotate(room, entry: entry, frames: frames) }
                }
            } catch {
                self.submitAfterCapture = false
                self.autoContinue = false
                self.message = "Could not save this room: \(error.localizedDescription). Previously saved rooms are still available." }
            self.processing = false
            if self.submitAfterCapture {
                self.submitAfterCapture = false
                await self.finishInspection()
            } else if self.autoContinue, self.inspection.link != nil {
                self.autoContinue = false
                await self.start()
            }
        }
    }

    func beginInspection() async {
        guard !scanning, !processing, inspection.link == nil,
              !inspection.busy, !inspection.connected else {
            inspection.pendingLink = nil
            inspection.status = "Fullfør den aktive skanningen før du starter en ny befaring."
            return
        }
        do {
            try await inspection.confirm()
            resetFloor()
            inspectionFinalizationStarted = false
            if let visit = inspection.link?.visit,
               let data = try? Data(contentsOf: inspectionRoomsFile(visit)),
               let records = try? JSONDecoder().decode([InspectionRoomRecord].self, from: data) {
                inspectionRooms = records.map { ($0.id, $0.saved) }
            } else { inspectionRooms = [] }
            inspection.restoreSavedRooms(inspectionRooms.map { $0.id.uuidString })
            inspectionRoomID = nil
            guideNamedRooms = [:]
            await start()
        } catch {
            inspection.status = "Kunne ikke starte befaringen. Kontroller innlogging og tilkobling."
        }
    }

    func captureInspectionEvidence() async {
        guard inspection.link != nil, !inspection.busy, !inspectionFinalizationStarted, !evidenceCaptureInProgress else { return }
        evidenceCaptureInProgress = true
        defer { evidenceCaptureInProgress = false }
        guard let request = inspection.request else { return }
        guard let frame = captureView.captureSession.arSession.currentFrame,
              ProcessInfo.processInfo.systemUptime - frame.timestamp < 2 else {
            inspection.status = "Kamerabildet er utilgjengelig. Prøv igjen."
            return
        }
        if case .normal = frame.camera.trackingState {
            let transform = frame.camera.transform
            let position = LiveMapPoint(Double(transform.columns.3.x), Double(transform.columns.3.z))
            let matches = liveMap.rooms.filter { $0.contains(position) }
            guard matches.count != 1 || matches[0].id.lowercased() == request.roomId.lowercased() else {
                inspection.status = "Gå til det forespurte rommet før du tar bildet."
                return
            }
        }
        await inspection.takeEvidence(frame.capturedImage)
    }

    func finishInspection() async {
        guard inspection.link != nil, !scanning, !processing, !inspection.busy, !evidenceCaptureInProgress else { return }
        guard hasInspectionRooms else {
            inspection.status = "Skann minst ett rom før du sender befaringen."
            return
        }
        scanGeneration += 1
        inspection.busy = true
        defer { inspection.busy = false }
        do {
            let convertedRooms = try inspectionRooms.map { item in
                (item: item, document: RoomPlanConverter.convert(try capturedRoom(item.saved)))
            }
            inspectionFinalizationStarted = true
            let submittedRooms = convertedRooms.map { item, converted in
                let saved = rooms.first(where: { $0.id == item.saved.id }) ?? item.saved
                let annotation = RoomAnnotationStore.load(directory: roomDirectory(saved))
                var document = annotation?.applying(to: converted) ?? converted
                if !document.floorplan.rooms.isEmpty { document.floorplan.rooms[0].id = item.id.uuidString.lowercased() }
                return InspectionGuide.ScannedRoom(roomId: item.id.uuidString.lowercased(), name: saved.name,
                                                   document: document, report: annotation?.markdown)
            }
            try await inspection.publishRooms(submittedRooms)
            try await inspection.finalize(rooms: submittedRooms)
            await inspection.disconnect()
            inspection.status = "Befaringen er sendt til jobbkortet."
            inspection.link = nil
            inspectionFinalizationStarted = false
        } catch {
            inspection.status = "Kunne ikke sende befaringen. Prøv igjen."
        }
    }

    func finishFloor() {
        guard !scanning, !processing, inspection.link == nil, !inspection.busy else { return }
        resetFloor()
    }

    private func resetFloor() {
        captureView.captureSession.arSession.pause()
        captureView.captureSession.delegate = nil
        sessionID = UUID()
        captureView = RoomCaptureView(frame: .zero, arSession: ARSession())
        captureView.captureSession.delegate = self
    }

    private func inspectionRoomsFile(_ visit: String) -> URL {
        directory.appending(path: "inspection-\(visit).json")
    }

    private func persistInspectionRooms() {
        guard let visit = inspection.link?.visit else { return }
        let records = inspectionRooms.map { InspectionRoomRecord(id: $0.id, saved: $0.saved) }
        guard let data = try? JSONEncoder().encode(records) else { return }
        try? data.write(to: inspectionRoomsFile(visit), options: [.atomic, .completeFileProtection])
    }

    private func save(_ room: CapturedRoom) throws -> SavedRoom {
        let entry = SavedRoom(id: UUID(), name: "Room \(rooms.count + 1)", createdAt: .now, sessionID: sessionID)
        let url = roomDirectory(entry)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        do {
            try JSONEncoder().encode(room).write(to: url.appending(path: "capture.json"), options: .atomic)
            try JSONEncoder().encode(entry).write(to: url.appending(path: "info.json"), options: .atomic)
            rooms.insert(entry, at: 0)
            return entry
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    private func annotate(_ room: CapturedRoom, entry: SavedRoom, frames: [String]) async {
        defer { annotationPending.remove(entry.id) }
        do {
            let annotation = try await RoomAnnotationClient.shared.analyze(frames: frames, room: room)
            guard let index = rooms.firstIndex(where: { $0.id == entry.id }) else { return }
            let directory = roomDirectory(entry)
            try RoomAnnotationStore.save(annotation, directory: directory)
            var updated = rooms[index]
            let inspectionID = inspectionRooms.first(where: { $0.saved.id == entry.id })?.id.uuidString.lowercased()
            updated.name = inspectionID.flatMap { guideNamedRooms[$0] } ?? annotation.name
            try JSONEncoder().encode(updated).write(to: directory.appending(path: "info.json"), options: .atomic)
            rooms[index] = updated
            if let id = inspectionID {
                updateMapName(id: id, name: updated.name)
                var document = annotation.applying(to: RoomPlanConverter.convert(room))
                if !document.floorplan.rooms.isEmpty {
                    document.floorplan.rooms[0].id = id
                    document.floorplan.rooms[0].name = updated.name
                }
                if let encoded = try? JSONEncoder().encode(document),
                   let object = try? JSONSerialization.jsonObject(with: encoded) {
                    inspection.postEvent("room.upsert", roomID: id,
                        data: ["name": updated.name, "document": object, "report": annotation.markdown])
                }
            }
        } catch {
            message = "Rommet er lagret, men rapporten kunne ikke lages: \(error.localizedDescription)"
        }
    }

    private func updateMapName(id: String, name: String) {
        func rename(_ map: inout LiveMapSnapshot) {
            map.rooms = map.rooms.map { $0.id.lowercased() == id ? SpatialRoom(id: $0.id, name: name, polygon: $0.polygon) : $0 }
            map.labels = map.labels.map { $0.id.lowercased() == id ? LiveMapRoom(id: $0.id, label: name, position: $0.position) : $0 }
        }
        rename(&savedFloorMap)
        rename(&liveMap)
    }

    private func renameInspectionRoom(id: String, name: String) {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let normalized = id.lowercased()
        guideNamedRooms[normalized] = name
        if inspectionRoomID?.uuidString.lowercased() == normalized { inspectionRoomName = name }
        updateMapName(id: normalized, name: name)
        guard
              let item = inspectionRooms.first(where: { $0.id.uuidString.lowercased() == id.lowercased() }),
              let index = rooms.firstIndex(where: { $0.id == item.saved.id }) else { return }
        var updated = rooms[index]
        updated.name = name
        do {
            try JSONEncoder().encode(updated).write(to: roomDirectory(updated).appending(path: "info.json"), options: .atomic)
            rooms[index] = updated

        } catch { message = "Could not save room name: \(error.localizedDescription)" }
    }

    private func loadRooms() throws -> [SavedRoom] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .compactMap { try? JSONDecoder().decode(SavedRoom.self, from: Data(contentsOf: $0.appending(path: "info.json"))) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func roomDirectory(_ room: SavedRoom) -> URL { directory.appending(path: room.id.uuidString, directoryHint: .isDirectory) }
    func capturedRoom(_ room: SavedRoom) throws -> CapturedRoom {
        try JSONDecoder().decode(CapturedRoom.self, from: Data(contentsOf: roomDirectory(room).appending(path: "capture.json")))
    }

    func canDelete(_ room: SavedRoom) -> Bool {
        inspection.link == nil || !inspectionRooms.contains { $0.saved.id == room.id }
    }

    func delete(_ room: SavedRoom) {
        guard canDelete(room) else { return }
        do {
            try FileManager.default.removeItem(at: roomDirectory(room))
            rooms.removeAll { $0.id == room.id }
        } catch { message = "Could not delete room: \(error.localizedDescription)" }
    }
}

struct CaptureCamera: UIViewRepresentable {
    let view: RoomCaptureView
    func makeUIView(context: Context) -> RoomCaptureView { view }
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}
