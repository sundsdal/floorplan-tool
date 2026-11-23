import ARKit
import CoreImage
import Foundation
import GoogleSignIn
import RoomPlan
import UIKit

struct RoomAnnotation: Codable {
    enum Observation: String, Codable {
        case observed, uncertain, not_observed

        var title: String {
            switch self {
            case .observed: "Observert"
            case .uncertain: "Usikkert"
            case .not_observed: "Ikke observert"
            }
        }
    }

    struct Features: Codable {
        let fireplace: Observation
        let toilet: Observation
        let ventilation: Observation
        let windows: Observation
    }

    let name: String
    let type: String
    let features: Features
    let summary: String

    func applying(to document: FloorplanDocument) -> FloorplanDocument {
        var updated = document
        for index in updated.floorplan.rooms.indices {
            updated.floorplan.rooms[index].name = name
            updated.floorplan.rooms[index].type = type
        }
        return updated
    }

    var markdown: String {
        """
        # \(name)

        \(summary)

        - Peis: \(features.fireplace.title)
        - Toalett: \(features.toilet.title)
        - Ventilasjon: \(features.ventilation.title)
        - Vinduer: \(features.windows.title)
        """
    }
}

enum RoomAnnotationStore {
    static let didUpdate = Notification.Name("RoomAnnotationDidUpdate")

    static func save(_ annotation: RoomAnnotation, directory: URL) throws {
        let data = try JSONEncoder().encode(annotation)
        try data.write(to: directory.appending(path: "annotation.json"), options: .atomic)
        NotificationCenter.default.post(name: didUpdate, object: directory)
    }

    static func load(directory: URL) -> RoomAnnotation? {
        guard let data = try? Data(contentsOf: directory.appending(path: "annotation.json")) else { return nil }
        return try? JSONDecoder().decode(RoomAnnotation.self, from: data)
    }
}

@MainActor
final class RoomFrameSampler {
    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private(set) var frames: [String] = []
    private var lastSample = Date.distantPast

    func reset() {
        frames.removeAll()
        lastSample = .distantPast
    }

    func sample(_ buffer: CVPixelBuffer?) {
        guard let buffer, Date().timeIntervalSince(lastSample) >= 3 else { return }
        lastSample = .now
        let image = CIImage(cvPixelBuffer: buffer).oriented(.right)
        let scale = min(1, 600 / max(image.extent.width, image.extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent),
              let data = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.55),
              data.count <= 150_000 else { return }
        if frames.count >= 12 {
            frames.remove(at: 3)
        }
        frames.append(data.base64EncodedString())
    }
}

private struct RoomEvidence: Encodable {
    let objects: [String]
    let windowCount: Int
}

private struct AnnotationRequest: Encodable {
    let frames: [String]
    let roomPlan: RoomEvidence
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class RoomAnnotationClient: ObservableObject {
    static let shared = RoomAnnotationClient()

    @Published private(set) var signedIn = false
    @Published var error: String?
    private let endpoint = URL(string: "https://floorplan-ai-vrefqfdtpa-lz.a.run.app/api/roomplan/annotate")!
    private let redirectDelegate = RejectRedirects()

    private init() {}

    private var configured: Bool {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String else { return false }
        return !value.isEmpty && !value.contains("$(")
    }

    func restore() async {
        guard configured else { return }
        do {
            _ = try await GIDSignIn.sharedInstance.restorePreviousSignIn()
            signedIn = true
        } catch {
            signedIn = false
        }
    }

    func signIn() async {
        guard configured else {
            error = "Google-innlogging er ikke konfigurert for denne appen."
            return
        }
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: \.isKeyWindow),
              let controller = window.rootViewController else {
            error = "Kunne ikke åpne innloggingen."
            return
        }
        do {
            _ = try await GIDSignIn.sharedInstance.signIn(withPresenting: controller)
            signedIn = true
            error = nil
        } catch {
            self.error = "Kunne ikke logge inn. Prøv igjen."
        }
    }

    func analyze(frames: [String], room: CapturedRoom) async throws -> RoomAnnotation {
        guard signedIn, !frames.isEmpty,
              let user = GIDSignIn.sharedInstance.currentUser else {
            throw URLError(.userAuthenticationRequired)
        }
        let refreshed = try await user.refreshTokensIfNeeded()
        guard let token = refreshed.idToken?.tokenString else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: endpoint, timeoutInterval: 120)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "X-Serverless-Authorization")
        request.httpBody = try JSONEncoder().encode(AnnotationRequest(
            frames: frames,
            roomPlan: RoomEvidence(
                objects: room.objects.prefix(100).map { String(String(describing: $0.category).prefix(80)) },
                windowCount: min(room.windows.count, 100)
            )
        ))
        let session = URLSession(configuration: .ephemeral, delegate: redirectDelegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(RoomAnnotation.self, from: data)
    }
}
