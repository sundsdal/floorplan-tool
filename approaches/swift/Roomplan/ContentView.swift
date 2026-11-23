import RoomPlan
import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var store = CaptureStore()
    @StateObject private var annotations = RoomAnnotationClient.shared

    var body: some View {
        NavigationStack {
            Group {
                if store.scanning {
                    ZStack(alignment: .bottom) {
                        CaptureCamera(view: store.captureView).ignoresSafeArea(edges: .bottom)
                        VStack {
                            HStack {
                                Spacer()
                                LiveRoomMap(snapshot: store.liveMap, camera: store.cameraPose)
                                    .frame(width: 180, height: 180)
                                    .padding(6)
                                    .background(.black.opacity(0.78), in: RoundedRectangle(cornerRadius: 16))
                            }
                            Spacer()
                            VStack(spacing: 16) {
                                Text(store.instruction).font(.subheadline).multilineTextAlignment(.center)
                                Button("Finish room", action: store.finish)
                                    .buttonStyle(.borderedProminent).controlSize(.large)
                            }
                            .padding().frame(maxWidth: .infinity)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                        }
                        .padding(.horizontal)
                    }
                } else {
                    List {
                        Section {
                            if store.processing {
                                ProgressView("Preparing room…")
                            } else {
                                Button { Task { await store.start() } } label: {
                                    Label("Scan a room", systemImage: "viewfinder")
                                }
                                .disabled(!store.supported)
                            }
                            if store.hasActiveFloor && !store.processing {
                                Button("Finish floor", action: store.finishFloor)
                            }
                            if !store.supported {
                                Text("Room scanning requires a supported device with LiDAR. You can use Floorplan AI for video capture instead. Saved scans can still be viewed and shared.")
                                    .font(.footnote).foregroundStyle(.secondary)
                            } else {
                                Text("Scan each room separately. Keep the app open between rooms and return to a scanned area if tracking needs to recover. Finish the floor before starting another.")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        Section("Romrapport") {
                            if annotations.signedIn {
                                Label("Innlogget for romrapporter", systemImage: "checkmark.circle")
                            } else {
                                Button {
                                    Task { await annotations.signIn() }
                                } label: {
                                    Label("Logg inn for romrapporter", systemImage: "person.crop.circle")
                                }
                                Text("Gemini bruker opptil 12 bilder fra skanningen til å gi rommet navn og skrive en kort rapport.")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                            if let error = annotations.error {
                                Text(error).font(.footnote).foregroundStyle(.red)
                            }
                        }
                        if store.rooms.contains(where: { $0.sessionID != nil }) {
                            Section("Floors") {
                                ForEach(Array(Set(store.rooms.compactMap(\.sessionID))), id: \.self) { sessionID in
                                    NavigationLink {
                                        FloorDetail(rooms: store.rooms.filter { $0.sessionID == sessionID }, store: store)
                                    } label: {
                                        let group = store.rooms.filter { $0.sessionID == sessionID }
                                        Label("Floor · \(group.count) room(s)", systemImage: "square.stack.3d.up")
                                    }
                                }
                            }
                        }
                        Section("Saved rooms") {
                            if store.rooms.isEmpty {
                                ContentUnavailableView("No rooms yet", systemImage: "square.dashed", description: Text("Completed room scans are saved on this device."))
                            }
                            ForEach(store.rooms) { room in
                                NavigationLink {
                                    RoomDetail(room: room, store: store)
                                } label: {
                                    VStack(alignment: .leading) {
                                        Text(room.name)
                                        if store.annotationPending.contains(room.id) {
                                            Text("Lager romrapport …").font(.caption).foregroundStyle(.secondary)
                                        } else {
                                            Text(room.createdAt, style: .date).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                            .onDelete { offsets in offsets.map { store.rooms[$0] }.forEach(store.delete) }
                        }
                    }
                }
            }
            .navigationTitle(store.scanning ? "Scanning" : "RoomPlan")
            .navigationBarTitleDisplayMode(store.scanning ? .inline : .large)
            .alert("RoomPlan", isPresented: Binding(get: { store.message != nil }, set: { if !$0 { store.message = nil } })) {
                Button("OK", role: .cancel) { store.message = nil }
            } message: { Text(store.message ?? "") }
        }
        .task { await annotations.restore() }
    }
}

struct RoomDetail: View {
    let room: SavedRoom
    @ObservedObject var store: CaptureStore
    @State private var exports: [URL] = []
    @State private var preview: String?
    @State private var annotation: RoomAnnotation?
    @State private var warnings: [String] = []
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Text("Saved on this device")
                Text("Review the plan before using its measurements. Exports are generated locally.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let preview {
                Section("Room plan") { SVGPreview(svg: preview).frame(height: 300) }
            }
            if store.annotationPending.contains(room.id) {
                Section("Romrapport") {
                    ProgressView("Lager romrapport …")
                }
            }
            if let annotation {
                Section("Romrapport") {
                    Text(annotation.summary)
                    LabeledContent("Peis", value: annotation.features.fireplace.title)
                    LabeledContent("Toalett", value: annotation.features.toilet.title)
                    LabeledContent("Ventilasjon", value: annotation.features.ventilation.title)
                    LabeledContent("Vinduer", value: annotation.features.windows.title)
                    ShareLink(item: annotation.markdown) {
                        Label("Del romrapport", systemImage: "square.and.arrow.up")
                    }
                }
            }
            if !warnings.isEmpty {
                Section("Review") { ForEach(warnings, id: \.self) { Text($0).font(.footnote) } }
            }
            Section("Share") {
                if exports.isEmpty { Button("Prepare exports") { prepareExports() } }
                ForEach(exports, id: \.self) { url in
                    ShareLink(item: url) { Label(url.pathExtension.uppercased(), systemImage: "square.and.arrow.up") }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle(annotation?.name ?? room.name)
        .onAppear {
            loadAnnotation()
            loadPreview()
        }
        .onReceive(NotificationCenter.default.publisher(for: RoomAnnotationStore.didUpdate)) { notification in
            guard let directory = notification.object as? URL,
                  directory == store.roomDirectory(room) else { return }
            loadAnnotation()
            loadPreview()
            exports = []
        }
    }

    private func loadAnnotation() {
        annotation = RoomAnnotationStore.load(directory: store.roomDirectory(room))
    }

    private func loadPreview() {
        do {
            let converted = RoomPlanConverter.convert(try store.capturedRoom(room))
            let document = annotation?.applying(to: converted) ?? converted
            preview = SVGRenderer.render(document: document)
            warnings = document.warnings
        } catch { self.error = "Could not load this room: \(error.localizedDescription)" }
    }

    private func prepareExports() {
        do {
            let capture = try store.capturedRoom(room)
            let directory = store.roomDirectory(room)
            let converted = RoomPlanConverter.convert(capture)
            let document = RoomAnnotationStore.load(directory: directory)?.applying(to: converted) ?? converted
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let json = directory.appending(path: "floorplan.json")
            try encoder.encode(document).write(to: json, options: .atomic)
            let svg = directory.appending(path: "floorplan.svg")
            try SVGRenderer.render(document: document).write(to: svg, atomically: true, encoding: .utf8)
            exports = [svg, json]
            error = nil
            do {
                let usdz = directory.appending(path: "room.usdz")
                try capture.export(to: usdz, exportOptions: .mesh)
                exports.append(usdz)
            } catch { self.error = "Could not prepare the 3D model: \(error.localizedDescription). The 2D exports are available." }
        } catch { self.error = "Could not prepare exports: \(error.localizedDescription)" }
    }
}

struct FloorDetail: View {
    let rooms: [SavedRoom]
    @ObservedObject var store: CaptureStore
    @State private var exports: [URL] = []
    @State private var preview: String?
    @State private var warnings: [String] = []
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        List {
            Section {
                Text("\(rooms.count) room(s) captured in one session")
                Text("Room positions depend on continuous tracking. Review the plan before using its measurements.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let preview {
                Section("Floor plan") { SVGPreview(svg: preview).frame(height: 300) }
            }
            if !warnings.isEmpty {
                Section("Review") { ForEach(warnings, id: \.self) { Text($0).font(.footnote) } }
            }
            Section("Share") {
                if busy { ProgressView("Building floor…") }
                else { Button("Build floor exports") { Task { await prepare() } } }
                ForEach(exports, id: \.self) { url in
                    ShareLink(item: url) { Label(url.pathExtension.uppercased(), systemImage: "square.and.arrow.up") }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            Section("Rooms") {
                ForEach(rooms) { room in
                    NavigationLink(room.name) { RoomDetail(room: room, store: store) }
                }
            }
        }
        .navigationTitle("Floor")
        .onReceive(NotificationCenter.default.publisher(for: RoomAnnotationStore.didUpdate)) { notification in
            guard let directory = notification.object as? URL,
                  rooms.contains(where: { store.roomDirectory($0) == directory }),
                  preview != nil, !busy else { return }
            Task { await prepare() }
        }
    }

    @MainActor private func prepare() async {
        busy = true
        defer { busy = false }
        do {
            let ordered = rooms.sorted { $0.createdAt < $1.createdAt }
            let captures = try ordered.map { try store.capturedRoom($0) }
            exports = []
            preview = nil
            warnings = []
            let structure = try await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: captures)
            var document = FloorplanDocument()
            for capture in structure.rooms {
                let saved = zip(ordered, captures).first { $0.1.identifier == capture.identifier }?.0
                let converted = RoomPlanConverter.convert(capture)
                let annotation = saved.flatMap { RoomAnnotationStore.load(directory: store.roomDirectory($0)) }
                let annotated = annotation?.applying(to: converted) ?? converted
                document.add(annotated, roomName: annotation?.name ?? saved?.name)
            }
            let svg = SVGRenderer.render(document: document)
            let directory = store.roomDirectory(ordered[0])
            let jsonURL = directory.appending(path: "floor.json")
            let svgURL = directory.appending(path: "floor.svg")
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(document).write(to: jsonURL, options: .atomic)
            try svg.write(to: svgURL, atomically: true, encoding: .utf8)
            preview = svg
            warnings = document.warnings
            exports = [svgURL, jsonURL]
            error = nil
            do {
                let usdz = directory.appending(path: "floor.usdz")
                try structure.export(to: usdz, exportOptions: .mesh)
                exports.append(usdz)
            } catch {
                self.error = "Could not build the combined 3D model: \(error.localizedDescription). Individual rooms remain available to export."
            }
        } catch {
            self.error = "Could not build the floor: \(error.localizedDescription). Individual rooms remain available to export."
        }
    }
}

struct SVGPreview: UIViewRepresentable {
    let svg: String
    func makeUIView(context: Context) -> WKWebView { WKWebView() }
    func updateUIView(_ view: WKWebView, context: Context) { view.loadHTMLString(svg, baseURL: nil) }
}
