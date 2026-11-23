import ARKit
import AVFoundation
import CoreImage
import Foundation
import GoogleSignIn
import LiveKit
import SwiftUI
import UIKit

struct InspectionLink {
    let origin: URL
    let job: String
    let visit: String
    let token: String
    let work: String

    init?(url: URL) {
        guard url.scheme == "floorplanscan", url.host == "inspection",
              url.path.isEmpty, url.fragment == nil,
              let configured = Bundle.main.object(forInfoDictionaryKey: "ROOMPLAN_INSPECTION_ORIGIN") as? String,
              !configured.isEmpty, !configured.contains("$("),
              let expected = URL(string: configured),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = parts.queryItems, items.count == 5 else { return nil }
        let values = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, _ in "" })
        guard let originValue = values["origin"], let origin = URL(string: originValue),
              origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ==
                expected.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
              origin.user == nil, origin.password == nil, origin.query == nil, origin.fragment == nil,
              let job = values["job"], job.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let visit = values["visit"], visit.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let token = values["token"], token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let work = values["work"], ["male", "slipe"].contains(work) else { return nil }
        self.origin = origin
        self.job = job
        self.visit = visit
        self.token = token
        self.work = work
    }
}

struct InspectionRequest: Codable, Identifiable {
    let requestId: String
    let roomId: String
    let roomName: String?
    let target: String
    let prompt: String
    var id: String { requestId }
}

struct InspectionEvidence: Encodable {
    let roomId: String
    let target: String
    let jpeg: String
    let requestId: String
    enum CodingKeys: String, CodingKey { case roomId, target, jpeg }
}

struct GuideSession: Decodable {
    let sessionId: String
    let serverUrl: String?
    let token: String?
    let sessionToken: String
    let keepalive: Bool?
    let finalizeOnly: Bool?

    var canCapture: Bool { finalizeOnly != true && serverUrl != nil && token != nil }
}

private struct Recording: Decodable { let startedAt: Double? }

struct SpatialLocation: Codable, Equatable {
    var capturedAt: Int64
    var tracking: String
    var roomId: String?
    var roomName: String?
    var position: LiveMapPoint?
    var forward: LiveMapPoint?
}

private struct SpatialSnapshot: Encodable {
    let capturedAt: Int64
    let seconds: Double
    let location: SpatialLocation
    let walls: [LiveMapLine]
    let doors: [LiveMapLine]
    let windows: [LiveMapLine]
    let rooms: [SpatialRoom]
    let image: String
}

private final class InspectionRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class InspectionGuide: NSObject, ObservableObject, RoomDelegate {
    @Published var link: InspectionLink?
    @Published var pendingLink: InspectionLink?
    @Published var request: InspectionRequest?
    @Published var status = ""
    @Published var busy = false
    @Published var connected = false
    @Published var evidence: [InspectionEvidence] = []
    private var room: Room?
    private var track: LocalVideoTrack?
    private var session: GuideSession?
    private var keepaliveTask: Task<Void, Never>?
    private var recordingTask: Task<Void, Never>?
    private var reliableTask: Task<Void, Never>?
    private var reliableTaskID: UUID?
    private struct PendingPacket {
        let key: String
        let topic: String
        let data: Data
    }
    private var pendingPackets: [PendingPacket] = []
    private var startTime: Double?
    private var activeRoom: (String, String)?
    private var finalized = false
    @Published var finalSummary = ""
    private var startTimeByRoom: [String: Double] = [:]
    private var roomsWithUnknownStart: Set<String> = []
    private var roomStartInstants: [String: Double] = [:]
    private var latestLocation: SpatialLocation?
    private var lastLocationSent: Int64 = 0
    private var lastSnapshotSent: Int64 = 0
    private var locationSending = false
    private var pendingLocation: SpatialLocation?
    private var snapshotSending = false
    private var eventTask: Task<Void, Never>?
    private var eventCursor = 0
    private var pendingEvents: [Data] = []
    var onRoomNamed: ((String, String) -> Void)?
    private let imageContext = CIContext()
    private let redirectDelegate = InspectionRedirectDelegate()
    private lazy var httpSession = URLSession(configuration: .ephemeral, delegate: redirectDelegate, delegateQueue: nil)
    private let cloudOrigin = URL(string: "https://floorplan-ai-vrefqfdtpa-lz.a.run.app")!
    var sessionID: String? { session?.sessionId }
    var finalizeOnly: Bool { session?.finalizeOnly == true }

    func receive(_ url: URL) {
        guard link == nil, !busy, !connected else {
            status = "Fullfør den aktive befaringen før du starter en ny."
            return
        }
        guard let parsed = InspectionLink(url: url) else {
            status = "Ugyldig lenke til befaringen."
            return
        }
        pendingLink = parsed
    }

    func confirm() async throws {
        guard let pendingLink, link == nil, !busy, !connected else {
            throw URLError(.cannotLoadFromNetwork)
        }
        guard RoomAnnotationClient.shared.signedIn else { throw URLError(.userAuthenticationRequired) }
        link = pendingLink
        self.pendingLink = nil
        session = nil
        publishedFinalRooms = false
        finalized = false
        startTime = nil
        activeRoom = nil
        roomsWithUnknownStart = []
        roomStartInstants = [:]
        startTimeByRoom = (try? Data(contentsOf: roomTimesFile(for: pendingLink.visit)))
            .flatMap { try? JSONDecoder().decode([String: Double].self, from: $0) } ?? [:]
        evidence = []
        request = nil
        finalSummary = ""
        latestLocation = nil
        pendingLocation = nil
        lastLocationSent = 0
        lastSnapshotSent = 0
        status = "Kobler til veilederen …"
        busy = true
        defer { busy = false }
        do {
            let payload = try JSONSerialization.data(withJSONObject: ["mode": "inspection", "work": pendingLink.work,
                "inspectionLink": ["job": pendingLink.job, "visit": pendingLink.visit,
                                   "origin": pendingLink.origin.absoluteString, "token": pendingLink.token]])
            let data = try await cloudRequest("/api/livekit/session", method: "POST", body: payload)
            let session = try JSONDecoder().decode(GuideSession.self, from: data)
            self.session = session
            eventCursor = 0
            pendingEvents = (try? Data(contentsOf: eventFile(for: pendingLink.visit)))
                .flatMap { try? JSONDecoder().decode([Data].self, from: $0) } ?? []
            if session.finalizeOnly == true {
                status = "Fortsetter innsendingen av opptaket …"
                return
            }
            guard session.canCapture, let serverUrl = session.serverUrl, let token = session.token else {
                throw URLError(.badServerResponse)
            }
            let room = Room(delegate: self)
            self.room = room
            try await room.connect(url: serverUrl, token: token)
            let track = await LocalVideoTrack.createBufferTrack(name: "roomplan-camera", source: .camera)
            self.track = track
            try await room.localParticipant.setMicrophone(enabled: true)
            connected = true
            eventTask = Task { [weak self] in await self?.syncEvents() }
            status = "Veilederen er tilkoblet."
            if session.keepalive == true {
                keepaliveTask = Task { [weak self] in await self?.keepAlive() }
            }
        } catch {
            await disconnect()
            link = nil
            self.pendingLink = pendingLink
            status = "Kunne ikke koble til veilederen. Prøv igjen."
            throw error
        }
    }

    func postEvent(_ type: String, roomID: String, data: [String: Any]) {
        let value: [String: Any] = ["id": UUID().uuidString.lowercased(), "type": type,
                                    "roomId": roomID, "data": data,
                                    "capturedAt": Int64(Date().timeIntervalSince1970 * 1000)]
        guard let encoded = try? JSONSerialization.data(withJSONObject: value) else { return }
        pendingEvents.append(encoded)
        persistEvents()
    }

    private func persistEvents() {
        guard let link else { return }
        guard let data = try? JSONEncoder().encode(pendingEvents) else { return }
        try? data.write(to: eventFile(for: link.visit), options: [.atomic, .completeFileProtection])
    }

    private func eventFile(for visit: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appending(path: "inspection-events-\(visit).json")
    }

    private func roomTimesFile(for visit: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appending(path: "inspection-room-times-\(visit).json")
    }

    private func persistRoomTimes() {
        guard let link, let data = try? JSONEncoder().encode(startTimeByRoom) else { return }
        try? data.write(to: roomTimesFile(for: link.visit), options: [.atomic, .completeFileProtection])
    }

    private func syncEvents() async {
        while !Task.isCancelled, let session {
            let path = "/api/livekit/session/\(session.sessionId)/inspection/events"
            do {
                // A rejected or temporarily unavailable outbound event must not prevent
                // receiving the request which may make that event valid.
                try? await flushEvents()
                let result = try await cloudRequest("\(path)?after=\(eventCursor)", timeout: 12)
                if let envelope = try JSONSerialization.jsonObject(with: result) as? [String: Any],
                   let events = envelope["events"] as? [[String: Any]],
                   let cursor = envelope["cursor"] as? Int {
                    for event in events {
                        guard let type = event["type"] as? String,
                              let roomID = event["roomId"] as? String,
                              let data = event["data"] as? [String: Any] else { continue }
                        if type == "room.named", let name = data["name"] as? String {
                            if activeRoom?.0.lowercased() == roomID.lowercased() { activeRoom = (roomID, name) }
                            onRoomNamed?(roomID, name)
                        } else if (type == "evidence.requested" || type == "evidence.retry"), let requestID = data["requestId"] as? String,
                                  let target = data["target"] as? String,
                                  !evidence.contains(where: { $0.requestId == requestID }) {
                            request = InspectionRequest(requestId: requestID, roomId: roomID,
                                roomName: data["roomName"] as? String, target: target,
                                prompt: data["prompt"] as? String ?? target)
                        } else if type == "evidence.saved", let requestID = data["requestId"] as? String,
                                  request?.requestId == requestID {
                            request = nil
                        }
                    }
                    eventCursor = cursor
                }
            } catch { /* Retry the same event and cursor after reconnecting. */ }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    func flushEvents() async throws {
        guard let session else { throw URLError(.notConnectedToInternet) }
        while let event = pendingEvents.first {
            _ = try await cloudRequest("/api/livekit/session/\(session.sessionId)/inspection/events", method: "POST", body: event, timeout: 12)
            // Another caller may have flushed this same id while the request was in flight.
            if pendingEvents.first == event {
                pendingEvents.removeFirst()
                persistEvents()
            }
        }
    }

    private var publishing = false
    private var published = false
    func capture(_ pixelBuffer: CVPixelBuffer) {
        guard let track, let capturer = track.capturer as? BufferCapturer else { return }
        capturer.capture(pixelBuffer, rotation: ._90)
        if !publishing && !published, let room {
            publishing = true
            Task {
                do {
                    _ = try await room.localParticipant.publish(videoTrack: track)
                    published = true
                    startRecording()
                } catch {
                    status = "Kunne ikke sende kamerabildet til veilederen."
                }
                publishing = false
            }
        }
    }

    private func cloudRequest(_ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval = 900) async throws -> Data {
        guard let user = GIDSignIn.sharedInstance.currentUser else { throw URLError(.userAuthenticationRequired) }
        let refreshed = try await user.refreshTokensIfNeeded()
        guard let token = refreshed.idToken?.tokenString,
              let url = URL(string: path, relativeTo: cloudOrigin) else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "X-Serverless-Authorization")
        if let session { request.setValue("Bearer \(session.sessionToken)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await httpSession.data(for: request)
        if path.hasSuffix("/finalize"), (response as? HTTPURLResponse)?.statusCode == 425 {
            throw InspectionSynchronizationError.waitingForVideo
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return data
    }

    private func keepAlive() async {
        while !Task.isCancelled, let session {
            do { _ = try await cloudRequest("/api/livekit/session/\(session.sessionId)/keepalive") }
            catch { try? await Task.sleep(for: .seconds(2)) }
        }
    }

    private func startRecording() {
        recordingTask = Task {
            for _ in 0..<30 where !Task.isCancelled {
                do {
                    guard let session else { return }
                    let data = try await cloudRequest("/api/livekit/session/\(session.sessionId)/recording", method: "POST", body: Data("{}".utf8))
                    if let started = try JSONDecoder().decode(Recording.self, from: data).startedAt {
                        startTime = started
                        for (id, instant) in roomStartInstants where startTimeByRoom[id] == nil {
                            startTimeByRoom[id] = max(0, instant - started / 1000)
                        }
                        persistRoomTimes()
                        enqueueRecording(started)
                        if let activeRoom { announceRoom(id: activeRoom.0, name: activeRoom.1, phase: "start") }
                        return
                    }
                } catch { }
                try? await Task.sleep(for: .seconds(2))
            }
            status = "Opptaket startet ikke. Kontroller tilkoblingen."
        }
    }

    func restoreSavedRooms(_ ids: [String]) {
        roomsWithUnknownStart = Set(ids.map { $0.lowercased() }.filter { startTimeByRoom[$0] == nil })
    }

    func announceRoom(id: String, name: String, phase: String) {
        if phase == "start" { activeRoom = (id, name) }
        let seconds = startTime.map { max(0, Date().timeIntervalSince1970 - $0 / 1000) } ?? 0
        let key = id.lowercased()
        if phase == "start", startTimeByRoom[key] == nil, !roomsWithUnknownStart.contains(key) {
            if roomStartInstants[key] == nil { roomStartInstants[key] = Date().timeIntervalSince1970 }
            if let startTime, let instant = roomStartInstants[key] {
                startTimeByRoom[key] = max(0, instant - startTime / 1000)
                persistRoomTimes()
            }
        }
        if phase == "finish" {
            if startTimeByRoom[key] == nil, startTime != nil, !roomsWithUnknownStart.contains(key) { startTimeByRoom[key] = seconds }
            persistRoomTimes()
            if activeRoom?.0 == id { activeRoom = nil }
        }
        let announcedSeconds = phase == "start" ? (startTimeByRoom[key] ?? seconds) : seconds
        if let data = try? JSONSerialization.data(withJSONObject: ["roomId": id, "name": name, "seconds": announcedSeconds, "phase": phase]) {
            enqueuePacket(key: "room:\(id):\(phase)", topic: "floorplan.inspection.room", data: data)
        }
    }

    private func send(_ value: [String: Any], topic: String) async {
        guard let room, let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        try? await room.localParticipant.publish(data: data, options: DataPublishOptions(topic: topic, reliable: true))
    }

    func updateSpatial(snapshot: LiveMapSnapshot, pose: LiveCameraPose?, tracking: String) {
        guard link != nil, session != nil, connected else { return }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let matches = pose.map { position in snapshot.rooms.filter { $0.contains(position.position) } } ?? []
        let currentRoom = tracking == "tracked" && matches.count == 1 ? matches.first : nil
        let location = SpatialLocation(
            capturedAt: now, tracking: tracking,
            roomId: currentRoom?.id, roomName: currentRoom?.name,
            position: tracking == "tracked" ? pose?.position : nil,
            forward: tracking == "tracked" ? pose?.forward : nil
        )
        let changed = latestLocation?.tracking != location.tracking || latestLocation?.roomId != location.roomId
        latestLocation = location
        if changed || now - lastLocationSent >= 2_000 {
            pendingLocation = location
            sendPendingLocation()
        }
        guard now - lastSnapshotSent >= 15_000, !snapshotSending,
              let session, let startTime else { return }
        let renderer = ImageRenderer(content:
            LiveRoomMap(snapshot: snapshot, camera: pose)
                .frame(width: 420, height: 420)
                .background(Color(red: 0.06, green: 0.13, blue: 0.11))
        )
        renderer.scale = 1
        guard let image = renderer.uiImage?.jpegData(compressionQuality: 0.65),
              image.count <= 250_000 else { return }
        let data = SpatialSnapshot(
            capturedAt: now, seconds: max(0, (Double(now) - startTime) / 1000), location: location,
            walls: snapshot.walls, doors: snapshot.doors, windows: snapshot.windows,
            rooms: snapshot.rooms, image: image.base64EncodedString()
        )
        guard let body = try? JSONEncoder().encode(data) else { return }
        snapshotSending = true
        lastSnapshotSent = now
        Task { [weak self] in
            guard let self else { return }
            defer { snapshotSending = false }
            do {
                _ = try await cloudRequest("/api/livekit/session/\(session.sessionId)/inspection/spatial", method: "PUT", body: body, timeout: 12)
                guard self.session?.sessionId == session.sessionId else { return }
                await send(["capturedAt": now], topic: "floorplan.inspection.spatial")
            } catch {
                // The next snapshot will retry using the newest map and pose.
            }
        }
    }

    private func sendPendingLocation() {
        guard !locationSending, pendingLocation != nil else { return }
        locationSending = true
        Task { [weak self] in
            guard let self else { return }
            defer { locationSending = false }
            while let location = pendingLocation, let room, connected {
                pendingLocation = nil
                do {
                    let data = try JSONEncoder().encode(location)
                    try await room.localParticipant.publish(data: data, options: DataPublishOptions(topic: "floorplan.inspection.location", reliable: true))
                    lastLocationSent = location.capturedAt
                } catch {
                    // The tracking loop will send the latest location on its next pass.
                    lastLocationSent = 0
                    return
                }
            }
        }
    }

    private func replayState(for callbackRoom: Room) {
        guard room === callbackRoom else { return }
        if let startTime { enqueueRecording(startTime) }
        if let activeRoom { announceRoom(id: activeRoom.0, name: activeRoom.1, phase: "start") }
        sendPendingPackets()
        if let latestLocation {
            pendingLocation = latestLocation
            sendPendingLocation()
        }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor [weak self] in self?.replayState(for: room) }
    }

    nonisolated func roomDidReconnect(_ room: Room) {
        Task { @MainActor [weak self] in self?.replayState(for: room) }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType: EncryptionType) {
        guard topic == "floorplan.inspection.request", participant?.kind == .agent,
              let request = try? JSONDecoder().decode(InspectionRequest.self, from: data),
              UUID(uuidString: request.roomId) != nil,
              !request.requestId.isEmpty, !request.target.isEmpty, !request.prompt.isEmpty else { return }
        Task { @MainActor [weak self] in
            guard let self, self.room === room, self.connected,
                  !self.evidence.contains(where: { $0.requestId == request.requestId }) else { return }
            self.request = request
        }
    }

    func takeEvidence(_ buffer: CVPixelBuffer?) async {
        guard let buffer, let request, room != nil,
              !evidence.contains(where: { $0.requestId == request.requestId }) else { return }
        let image = CIImage(cvPixelBuffer: buffer).oriented(.right)
        let scale = min(1, 1200 / max(image.extent.width, image.extent.height))
        let resized = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = imageContext.createCGImage(resized, from: resized.extent),
              let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.7) else {
            status = "Kunne ikke ta bildet. Prøv igjen."
            return
        }
        let encodedImage = jpeg.base64EncodedString()
        postEvent("evidence.saved", roomID: request.roomId.lowercased(), data: ["requestId": request.requestId, "target": request.target, "jpeg": encodedImage])
        do { try await flushEvents() } catch {
            status = "Kunne ikke lagre bildet. Prøv igjen."
            return
        }
        evidence.append(InspectionEvidence(roomId: request.roomId.lowercased(), target: request.target, jpeg: encodedImage, requestId: request.requestId))
        self.request = nil
        // Keep the notification until LiveKit accepts it, independent of the local photo.
        if let data = try? JSONSerialization.data(withJSONObject: ["requestId": request.requestId, "roomId": request.roomId.lowercased()]) {
            enqueuePacket(key: "evidence:\(request.requestId)", topic: "floorplan.inspection.evidence", data: data)
        }
    }

    private func enqueueRecording(_ startedAt: Double) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["startedAt": startedAt]) else { return }
        enqueuePacket(key: "recording", topic: "floorplan.recording", data: data)
    }

    private func enqueuePacket(key: String, topic: String, data: Data) {
        guard !pendingPackets.contains(where: { $0.key == key }) else { return }
        pendingPackets.append(PendingPacket(key: key, topic: topic, data: data))
        sendPendingPackets()
    }

    private func sendPendingPackets() {
        guard reliableTask == nil, !pendingPackets.isEmpty, let room, connected else { return }
        let taskID = UUID()
        reliableTaskID = taskID
        reliableTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if reliableTaskID == taskID {
                    reliableTask = nil
                    reliableTaskID = nil
                }
            }
            while !Task.isCancelled, self.room === room, connected,
                  let packet = pendingPackets.first {
                do {
                    try await room.localParticipant.publish(data: packet.data, options: DataPublishOptions(topic: packet.topic, reliable: true))
                    guard !Task.isCancelled, self.room === room, reliableTaskID == taskID else { return }
                    pendingPackets.removeFirst()
                } catch {
                    guard !Task.isCancelled, self.room === room, reliableTaskID == taskID else { return }
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
            }
        }
    }

    private var publishedFinalRooms = false

    private enum InspectionSynchronizationError: Error { case waitingForVideo }

    private func finalizeRequest(path: String, body: Data) async throws -> Data {
        for attempt in 0..<60 {
            do { return try await cloudRequest(path, method: "POST", body: body) }
            catch InspectionSynchronizationError.waitingForVideo where attempt < 59 {
                status = "Venter på opptaket og dokumentasjonsbildene …"
                try await Task.sleep(for: .seconds(3))
            }
        }
        throw InspectionSynchronizationError.waitingForVideo
    }

    struct FinalRoom: Encodable {
        let roomId: String
        let name: String
        let seconds: Double?
    }

    static func finalRooms(_ rooms: [(id: String, name: String)], times: [String: Double]) -> [FinalRoom] {
        rooms.map { room in
            FinalRoom(roomId: room.id, name: room.name,
                      seconds: times[room.id.lowercased()])
        }
    }

    func finalize(rooms: [ScannedRoom]) async throws {
        guard !finalized, let session, let link else { return }
        try await flushEvents()
        struct FinalBody: Encodable {
            let work: String
            let rooms: [FinalRoom]
            let evidence: [FinalEvidence]
        }
        struct FinalEvidence: Encodable {
            let requestId: String
            let roomId: String
            let target: String
        }
        let body = try JSONEncoder().encode(FinalBody(
            work: link.work,
            rooms: Self.finalRooms(rooms.map { ($0.roomId, $0.name) }, times: startTimeByRoom),
            evidence: evidence.map { FinalEvidence(requestId: $0.requestId, roomId: $0.roomId, target: $0.target) }
        ))
        let response = try await finalizeRequest(path: "/api/livekit/session/\(session.sessionId)/inspection/finalize", body: body)
        struct FinalRequest: Decodable { let roomId: String; let target: String }
        struct FinalResult: Decodable { let summary: String; let requests: [FinalRequest] }
        let result = try JSONDecoder().decode(FinalResult.self, from: response)
        let missing = result.requests.map { item in
            let name = rooms.first(where: { $0.roomId.lowercased() == item.roomId.lowercased() })?.name ?? "Rom"
            return "\(name): \(item.target)"
        }
        let summary = ([result.summary] + missing).joined(separator: "\n")
        finalSummary = String(decoding: summary.utf16.prefix(2500), as: UTF16.self)
        finalized = true
    }

    struct ScannedRoom: Encodable {
        let roomId: String
        let name: String
        let document: FloorplanDocument
        let report: String?
    }

    func publishRooms(_ rooms: [ScannedRoom]) async throws {
        guard !publishedFinalRooms else { return }
        for room in rooms {
            let encoded = try JSONEncoder().encode(room.document)
            let document = try JSONSerialization.jsonObject(with: encoded)
            var data: [String: Any] = ["name": room.name, "document": document]
            if let report = room.report { data["report"] = report }
            postEvent("room.upsert", roomID: room.roomId, data: data)
        }
        try await flushEvents()
        publishedFinalRooms = true
    }

    func submit(rooms: [ScannedRoom]) async throws {
        guard let link else { return }
        struct Result: Encodable {
            let rooms: [ScannedRoom]
            let evidence: [InspectionEvidence]
            let videoSessionId: String?
            let summary: String?
        }
        let url = link.origin.appending(path: "api/jobs/\(link.job)/inspections/\(link.visit)")
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.httpMethod = "PUT"
        request.httpBody = try JSONEncoder().encode(Result(rooms: rooms, evidence: evidence, videoSessionId: sessionID, summary: finalSummary.isEmpty ? nil : finalSummary))
        request.setValue("Bearer \(link.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await httpSession.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    }

    func disconnect() async {
        eventTask?.cancel()
        eventTask = nil
        recordingTask?.cancel()
        keepaliveTask?.cancel()
        reliableTask?.cancel()
        reliableTask = nil
        reliableTaskID = nil
        pendingPackets.removeAll()
        let disconnectedRoom = room
        room = nil
        connected = false
        request = nil
        if let disconnectedRoom { await disconnectedRoom.disconnect() }
        track = nil
        session = nil
        publishing = false
        published = false
        latestLocation = nil
        pendingLocation = nil
        lastLocationSent = 0
        lastSnapshotSent = 0
    }
}
