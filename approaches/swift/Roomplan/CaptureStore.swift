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
    let inspection = InspectionGuide()
    private var inspectionRoomID: UUID?
    private var inspectionRooms: [(id: UUID, saved: SavedRoom)] = []

    override init() {
        let arSession = ARSession()
        captureView = RoomCaptureView(frame: .zero, arSession: arSession)
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appending(path: "RoomCaptures", directoryHint: .isDirectory)
        super.init()
        captureView.captureSession.delegate = self
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            rooms = try loadRooms()
        } catch { message = "Could not load saved rooms: \(error.localizedDescription)" }
    }

    var supported: Bool { RoomCaptureSession.isSupported }

    func start() async {
        guard supported else { message = "RoomPlan requires a supported iPhone or iPad with LiDAR."; return }
        let authorized = await AVCaptureDevice.requestAccess(for: .video)
        guard authorized else { message = "Allow camera access in Settings to scan a room."; return }
        stopping = false
        if inspection.link != nil {
            let roomID = UUID()
            inspectionRoomID = roomID
            Task { await inspection.announceRoom(id: roomID.uuidString.lowercased(), name: "Rom \(inspectionRooms.count + 1)", phase: "start") }
        }
        frameSampler.reset()
        savedFloorMap = LiveMapSnapshot()
        for entry in rooms where entry.sessionID == sessionID {
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
                    SpatialRoom(id: id.uuidString.lowercased(), name: "Rom \(self.inspectionRooms.count + 1)", polygon: $0.polygon)
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
                self.processing = false
                self.message = "Scan ended: \(errorDescription). Previously saved rooms are still available."
                return
            }
            self.processing = true
            do {
                let room = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
                let entry = try self.save(room)
                if let id = self.inspectionRoomID {
                    self.inspectionRooms.append((id: id, saved: entry))
                    self.savedFloorMap.add(room, name: entry.name, roomID: id.uuidString.lowercased())
                    self.liveMap = self.savedFloorMap
                    await self.inspection.announceRoom(id: id.uuidString.lowercased(), name: entry.name, phase: "finish")
                    self.inspectionRoomID = nil
                }
                if RoomAnnotationClient.shared.signedIn && !frames.isEmpty {
                    self.annotationPending.insert(entry.id)
                    Task { await self.annotate(room, entry: entry, frames: frames) }
                }
            } catch { self.message = "Could not save this room: \(error.localizedDescription). Previously saved rooms are still available." }
            self.processing = false
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
            finishFloor()
            inspectionRooms = []
            inspectionRoomID = nil
            await start()
        } catch {
            inspection.status = "Kunne ikke starte befaringen. Kontroller innlogging og tilkobling."
        }
    }

    func captureInspectionEvidence() async {
        guard !evidenceCaptureInProgress else { return }
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
        guard !scanning && !processing else { return }
        inspection.busy = true
        defer { inspection.busy = false }
        do {
            try await inspection.finalize()
            let submittedRooms = try inspectionRooms.map { item in
                let saved = rooms.first(where: { $0.id == item.saved.id }) ?? item.saved
                let annotation = RoomAnnotationStore.load(directory: roomDirectory(saved))
                let converted = RoomPlanConverter.convert(try capturedRoom(saved))
                var document = annotation?.applying(to: converted) ?? converted
                if !document.floorplan.rooms.isEmpty { document.floorplan.rooms[0].id = item.id.uuidString.lowercased() }
                return InspectionGuide.ScannedRoom(roomId: item.id.uuidString.lowercased(), name: saved.name,
                                                   document: document, report: annotation?.markdown)
            }
            try await inspection.submit(rooms: submittedRooms)
            await inspection.disconnect()
            inspection.status = "Befaringen er sendt til jobbkortet."
            inspection.link = nil
        } catch {
            inspection.status = "Kunne ikke sende befaringen. Prøv igjen."
        }
    }

    func finishFloor() {
        guard !scanning && !processing else { return }
        captureView.captureSession.arSession.pause()
        captureView.captureSession.delegate = nil
        sessionID = UUID()
        captureView = RoomCaptureView(frame: .zero, arSession: ARSession())
        captureView.captureSession.delegate = self
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
            updated.name = annotation.name
            try JSONEncoder().encode(updated).write(to: directory.appending(path: "info.json"), options: .atomic)
            rooms[index] = updated
            if let id = inspectionRooms.first(where: { $0.saved.id == entry.id })?.id.uuidString.lowercased() {
                func rename(_ map: inout LiveMapSnapshot) {
                    map.rooms = map.rooms.map {
                        $0.id == id ? SpatialRoom(id: id, name: annotation.name, polygon: $0.polygon) : $0
                    }
                    map.labels = map.labels.map {
                        $0.id == id ? LiveMapRoom(id: id, label: annotation.name, position: $0.position) : $0
                    }
                }
                rename(&savedFloorMap)
                rename(&liveMap)
            }
        } catch {
            message = "Rommet er lagret, men rapporten kunne ikke lages: \(error.localizedDescription)"
        }
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

    func delete(_ room: SavedRoom) {
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
