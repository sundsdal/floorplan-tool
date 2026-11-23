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
        frameSampler.reset()
        savedFloorMap = LiveMapSnapshot()
        for entry in rooms where entry.sessionID == sessionID {
            if let room = try? capturedRoom(entry) {
                savedFloorMap.add(room, name: entry.name)
            }
        }
        liveMap = savedFloorMap
        cameraPose = nil
        scanning = true
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
        trackingTask = Task {
            while !Task.isCancelled && scanning {
                if let frame = captureView.captureSession.arSession.currentFrame {
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
                    if RoomAnnotationClient.shared.signedIn {
                        frameSampler.sample(frame.capturedImage)
                    }
                }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
    }

    func finish() {
        guard scanning, !stopping else { return }
        stopping = true
        processing = true
        captureView.captureSession.stop(pauseARSession: false)
    }

    nonisolated func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        let sessionIdentity = ObjectIdentifier(session)
        let snapshot = LiveMapSnapshot(room)
        Task { @MainActor [weak self] in
            guard let self, self.scanning,
                  ObjectIdentifier(self.captureView.captureSession) == sessionIdentity else { return }
            var combined = self.savedFloorMap
            combined.walls.append(contentsOf: snapshot.walls)
            combined.doors.append(contentsOf: snapshot.doors)
            combined.windows.append(contentsOf: snapshot.windows)
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
            self.trackingTask?.cancel()
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
                if RoomAnnotationClient.shared.signedIn && !frames.isEmpty {
                    self.annotationPending.insert(entry.id)
                    Task { await self.annotate(room, entry: entry, frames: frames) }
                }
            } catch { self.message = "Could not save this room: \(error.localizedDescription). Previously saved rooms are still available." }
            self.processing = false
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
