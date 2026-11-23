import GoogleSignIn
import SwiftUI

@main
struct RoomplanApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { url in _ = GIDSignIn.sharedInstance.handle(url) }
        }
    }
}
