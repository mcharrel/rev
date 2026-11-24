import AppKit
import CoreServices

let routerID = "com.mcharrel.rev.links"
func pullURL(_ url: URL) -> URL? {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
          ["https", "http"].contains(c.scheme?.lowercased() ?? ""),
          c.host?.lowercased() == "github.com", c.user == nil, c.password == nil, c.port == nil,
          let match = c.percentEncodedPath.range(of: "^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*(?=/|$)", options: .regularExpression)
    else { return nil }
    let path = String(c.percentEncodedPath[match])
    guard let number = Int64(path.split(separator: "/").last ?? ""), number <= 9007199254740991 else { return nil }
    return URL(string: "https://github.com" + path)
}
if CommandLine.arguments.contains("--self-test") {
    let cases: [(String, String?)] = [
        ("https://github.com/example/repo/pull/12/files?x=1#comment", "https://github.com/example/repo/pull/12"),
        ("http://GITHUB.COM/example/repo/pull/7", "https://github.com/example/repo/pull/7"),
        ("https://github.com/example/repo/pull/0", nil),
        ("https://github.com/example/repo/pull/9007199254740992", nil),
        ("https://github.com/example/repo/pull/12junk", nil),
        ("https://github.com/example/repo/issues/12", nil),
        ("https://github.com.evil.example/example/repo/pull/12", nil),
        ("https://name@github.com/example/repo/pull/12", nil),
        ("https://github.com:443/example/repo/pull/12", nil),
        ("https://github.com/example%2Frepo/pull/12", nil),
        ("file:///example/repo/pull/12", nil),
    ]
    for (input, expected) in cases { precondition(pullURL(URL(string: input)!)?.absoluteString == expected, input) }
    print("11 PR routing cases passed")
    exit(0)
}
let preferences = UserDefaults.standard
let workspace = NSWorkspace.shared
let bundleURL = Bundle.main.bundleURL
let serverURL = bundleURL.deletingLastPathComponent().deletingLastPathComponent()
let revURL = serverURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
func enabled() -> Bool { preferences.synchronize(); return preferences.object(forKey: "enabled") == nil || preferences.bool(forKey: "enabled") }
func handler(_ scheme: String) -> URL? { workspace.urlForApplication(toOpen: URL(string: scheme + "://example.invalid")!) }
func isRouter(_ app: URL?) -> Bool { app.flatMap { Bundle(url: $0)?.bundleIdentifier } == routerID }
func browser(_ scheme: String) -> URL? {
    if let current = handler(scheme), !isRouter(current) { return current }
    let saved = preferences.string(forKey: "browser-" + scheme)
        ?? preferences.string(forKey: "browser-" + (scheme == "https" ? "http" : "https")) ?? "com.apple.Safari"
    if saved != routerID, let app = workspace.urlForApplication(withBundleIdentifier: saved) { return app }
    return workspace.urlForApplication(withBundleIdentifier: "com.apple.Safari")
}
func status(_ error: String? = nil) {
    var value: [String: Any] = ["supported": true, "enabled": enabled(),
        "registered": isRouter(handler("http")) && isRouter(handler("https")),
        "browser": browser("https")?.deletingPathExtension().lastPathComponent ?? "your browser"]
    if let error = error { value["error"] = error }
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
func configure(_ on: Bool) {
    preferences.set(on, forKey: "enabled")
    preferences.set(true, forKey: "setupAttempted")
    _ = LSRegisterURL(bundleURL as CFURL, true)
    // macOS can change both schemes in one approval, so remember both before changing either.
    if on {
        for scheme in ["http", "https"] {
            let current = handler(scheme)
            if !isRouter(current), let id = current.flatMap({ Bundle(url: $0)?.bundleIdentifier }) {
                preferences.set(id, forKey: "browser-" + scheme)
            }
        }
        preferences.synchronize()
    }
    var failure: String?
    for scheme in ["http", "https"] {
        let current = handler(scheme)
        // Never overwrite a browser the user selected outside rev.
        if on ? isRouter(current) : !isRouter(current) { continue }
        guard let destination = on ? bundleURL : browser(scheme) else { continue }
        var finished = false
        workspace.setDefaultApplication(at: destination, toOpenURLsWithScheme: scheme) { error in
            if let error = error { failure = error.localizedDescription }
            finished = true
        }
        while !finished { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
        if failure != nil { break }
    }
    preferences.synchronize()
    status(failure)
}
func openInBrowser(_ url: URL, completion: ((Bool) -> Void)? = nil) {
    guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let app = browser(url.scheme!.lowercased()) else { completion?(false); return }
    workspace.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { application, error in
        completion?(application != nil && error == nil)
    }
}
func openPull(_ url: URL) {
    let process = Process()
    process.executableURL = revURL.appendingPathComponent("Contents/MacOS/glassbox-node")
    process.arguments = [serverURL.appendingPathComponent("rev.js").path, "open", url.absoluteString]
    var env = ProcessInfo.processInfo.environment
    // A Slack/browser click must never inherit the helper launcher's Codex chat.
    env.removeValue(forKey: "CODEX_THREAD_ID")
    env.removeValue(forKey: "REV_DESKTOP_LAUNCHER")
    if let path = preferences.string(forKey: "workspace") { env["REV_DATA_DIR"] = path }
    // Finder launches do not inherit the user's terminal PATH (gh is commonly installed here).
    env["PATH"] = (env["PATH"] ?? "/usr/bin:/bin") + ":/opt/homebrew/bin:/usr/local/bin"
    process.environment = env
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do { try process.run(); process.waitUntilExit() } catch { openInBrowser(url); return }
    guard process.terminationStatus == 0 else { openInBrowser(url); return }
    let controlDir = env["REV_CONFIG_DIR"] ?? NSHomeDirectory() + "/.local/share/rev"
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: controlDir + "/connection.json")),
          let connection = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let port = connection["port"] as? Int, (1...65535).contains(port) else { openInBrowser(url); return }
    DispatchQueue.main.async {
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = ["--workspace"]
        config.environment = ["GLASSBOX_SERVER_URL": "http://127.0.0.1:\(port)"]
        workspace.openApplication(at: revURL, configuration: config)
    }
}
let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--remember-workspace", args.count == 2 {
    let root = URL(fileURLWithPath: args[1], isDirectory: true)
    for candidate in [root.appendingPathComponent(".glassbox"), root] {
        if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("workspace.json").path) {
            preferences.set(candidate.path, forKey: "workspace"); preferences.synchronize(); break
        }
    }
    exit(0)
}
if args.first == "--status" { status(); exit(0) }
if args.first == "--enable" { configure(true); exit(0) }
if args.first == "--disable" { configure(false); exit(0) }
if args.first == "--auto-enable" {
    if enabled() && !preferences.bool(forKey: "setupAttempted") { configure(true) }
    exit(0)
}
if args.first == "--browser", args.count == 2, let url = URL(string: args[1]) {
    var opened: Bool? = nil
    openInBrowser(url) { opened = $0 }
    let deadline = Date(timeIntervalSinceNow: 10)
    while opened == nil && Date() < deadline { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
    exit(opened == true ? 0 : 1)
}
class Delegate: NSObject, NSApplicationDelegate {
    let queue = DispatchQueue(label: "rev.links")
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if enabled(), let pr = pullURL(url) { queue.async { openPull(pr) } }
            else { openInBrowser(url) }
        }
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
