import AppKit
import WebKit
import Darwin

/// A Mac window for the local Personal Commentary server. The app starts `node server/index.ts` as its child and holds the
/// child's stdin open; quitting (or crashing) closes it, and the server shuts down on EOF. Links that leave the app
/// open in Chrome, where you're signed in to X.
@MainActor
final class PersonalCommentaryApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var status: NSTextField!
    private var server: Process?
    private var control: Pipe?
    private var output = Data()
    private var origin: URL?
    private var quitting = false
    private var mayQuit = false
    private var failed = false

    private static let paper = NSColor(srgbRed: 0xfa / 255, green: 0xf3 / 255, blue: 0xe6 / 255, alpha: 1)
    private static let ink = NSColor(srgbRed: 0x15 / 255, green: 0x47 / 255, blue: 0x26 / 255, alpha: 1)

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Personal Commentary"
        window.minSize = NSSize(width: 720, height: 540)
        window.backgroundColor = Self.paper
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("PersonalCommentaryWindow")

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default() // keeps the page's local preferences between launches
        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.isHidden = true
        window.contentView!.addSubview(webView)

        status = NSTextField(labelWithString: "Opening Personal Commentary…")
        status.font = NSFont.systemFont(ofSize: 17, weight: .medium)
        status.textColor = Self.ink
        status.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(status)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
        ])
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startServer()
    }

    // The page owns ⌘S, ⌘K, ⌘1–3, ⌘, and ⌘↩, so the menus leave those keys alone.
    private func makeMenu() {
        let main = NSMenu()
        let appMenu = NSMenu(title: "Personal Commentary")
        appMenu.addItem(withTitle: "About Personal Commentary", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Personal Commentary", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Personal Commentary", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"),
                                     ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: ""); editItem.submenu = edit; main.addItem(editItem)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        view.addItem(withTitle: "Open in Chrome", action: #selector(openInChrome), keyEquivalent: "").target = self
        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: ""); viewItem.submenu = view; main.addItem(viewItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: ""); windowItem.submenu = windowMenu; main.addItem(windowItem)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    // MARK: Server

    private func startServer() {
        let environment = ProcessInfo.processInfo.environment
        let root = environment["COMMENTARY_ROOT"] ?? (Bundle.main.object(forInfoDictionaryKey: "CommentaryRoot") as? String) ?? ""
        let node = environment["COMMENTARY_NODE"] ?? (Bundle.main.object(forInfoDictionaryKey: "CommentaryNode") as? String) ?? ""
        let files = FileManager.default
        guard files.fileExists(atPath: root + "/server/index.ts") else {
            fail("Personal Commentary couldn't find its project folder (\(root)). If you moved it, run npm run mac-app in the new location.")
            return
        }
        guard files.isExecutableFile(atPath: node) else {
            fail("Personal Commentary couldn't find Node at \(node). Install Node 24, then run npm run mac-app in the project folder.")
            return
        }
        guard files.fileExists(atPath: root + "/dist/web/index.html") else {
            fail("The web app isn't built yet. In the project folder, run npm run mac-app.")
            return
        }

        let child = Process()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = ["server/index.ts"]
        child.currentDirectoryURL = URL(fileURLWithPath: root)
        var env = environment
        env["NODE_ENV"] = "production"
        env["COMMENTARY_MANAGED"] = "1"
        env["PATH"] = [URL(fileURLWithPath: node).deletingLastPathComponent().path, "/opt/homebrew/bin", "/usr/local/bin",
                       env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        child.environment = env

        let input = Pipe(), stdout = Pipe()
        child.standardInput = input
        child.standardOutput = stdout
        child.standardError = serverLog() ?? FileHandle.nullDevice
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.receive(data) }
        }
        child.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.quitting, !self.mayQuit else { return }
                // A structured startup error can arrive just before the exit.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.fail("The Personal Commentary server stopped (exit \(process.terminationStatus)). Your notes are saved up to the last autosave. Reopen Personal Commentary to continue; details are in ~/Library/Logs/PersonalCommentary/server.out.")
                }
            }
        }
        do {
            try child.run()
        } catch {
            fail("Personal Commentary couldn't start Node: \(error.localizedDescription)")
            return
        }
        server = child
        control = input
        // Only this app holds the write end, so the server sees EOF the moment the app goes away.
        input.fileHandleForReading.closeFile()
        stdout.fileHandleForWriting.closeFile()
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, self.origin == nil else { return }
            self.fail("Personal Commentary took too long to start. Details are in ~/Library/Logs/PersonalCommentary/server.out.")
        }
    }

    private func serverLog() -> FileHandle? {
        let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/PersonalCommentary")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("server.out")
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        guard let handle = try? FileHandle(forWritingTo: file) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }

    private func receive(_ data: Data) {
        output.append(data)
        while let newline = output.firstIndex(of: 10) {
            let line = output.prefix(upTo: newline)
            output.removeSubrange(...newline)
            guard let event = (try? JSONSerialization.jsonObject(with: line)) as? [String: String] else { continue }
            if event["event"] == "error" { fail(event["message"] ?? "Personal Commentary couldn't start."); return }
            if event["event"] == "ready", let text = event["url"], let url = URL(string: text),
               url.scheme == "http", url.host == "127.0.0.1", url.port != nil, origin == nil, !quitting {
                origin = url
                webView.load(URLRequest(url: url))
            }
        }
    }

    private func fail(_ message: String) {
        guard !failed, !quitting, !mayQuit else { return }
        failed = true
        let alert = NSAlert()
        alert.messageText = "Personal Commentary couldn't open"
        alert.informativeText = message
        alert.runModal()
        mayQuit = true
        // Leave the dispatch callback before entering AppKit's termination loop.
        DispatchQueue.main.async { self.stopServer { NSApp.terminate(nil) } }
    }

    private func stopServer(_ completion: @escaping () -> Void) {
        control?.fileHandleForWriting.closeFile()
        control = nil
        guard let child = server, child.isRunning else { completion(); return }
        let start = Date()
        func waitForExit() {
            if !child.isRunning { completion(); return }
            let elapsed = Date().timeIntervalSince(start)
            if elapsed > 8 { kill(child.processIdentifier, SIGKILL) }
            else if elapsed > 5 { child.terminate() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { waitForExit() }
        }
        waitForExit()
    }

    // MARK: Quitting

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if mayQuit || server == nil { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        // Send any autosave still waiting on its timer, then stop the server.
        webView.callAsyncJavaScript("return await (window.CommentaryDesktop?.prepareToQuit() ?? true);",
                                    arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let value) = result, (value as? Bool) != false {
                self.finishQuit()
            } else if !self.webView.isHidden {
                let alert = NSAlert()
                alert.messageText = "Your latest changes didn't save"
                alert.informativeText = "Personal Commentary is still open with your writing on screen. Stay open to try again, or quit and lose the last few seconds of typing."
                alert.addButton(withTitle: "Stay Open")
                alert.addButton(withTitle: "Quit Anyway")
                alert.beginSheetModal(for: self.window) { response in
                    if response == .alertSecondButtonReturn { self.finishQuit() }
                    else { self.quitting = false; NSApp.reply(toApplicationShouldTerminate: false) }
                }
            } else {
                self.finishQuit() // the page never loaded, so there's nothing to save
            }
        }
        return .terminateLater
    }

    private func finishQuit() {
        webView.isHidden = true
        status.stringValue = "Closing Personal Commentary…"
        status.isHidden = false
        stopServer {
            self.mayQuit = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
    }

    // MARK: Navigation

    @objc private func reload() { webView.reload() }
    @objc private func openInChrome() { if let origin { openExternal(webView.url ?? origin) } }

    private func isLocal(_ url: URL) -> Bool {
        guard let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    private func openExternal(_ url: URL) {
        let scheme = url.scheme?.lowercased() ?? ""
        if ["http", "https"].contains(scheme),
           let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") {
            NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
        } else if ["http", "https", "mailto"].contains(scheme) {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isLocal(url) || url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        openExternal(url)
    }

    // target="_blank" links (sources, the X composer) open in Chrome rather than a second app window.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isLocal(url) { webView.load(URLRequest(url: url)) } else { openExternal(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard origin != nil else { return }
        status.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if !quitting { fail("The page didn't load: \(error.localizedDescription)") }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Autosave runs within a second of typing, so a reload loses at most that much.
        webView.reload()
    }
}

@main
struct PersonalCommentaryMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = PersonalCommentaryApp()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        app.run()
    }
}
