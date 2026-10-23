import AppKit
import WebKit
import ServiceManagement
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusView: NSStackView!
    private var statusText: NSTextField!
    private var statusItem: NSStatusItem!
    private var loginItem: NSMenuItem!
    private var workerStatus: NSMenuItem!
    private var externalWorker = false
    private var worker: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var buffer = Data()
    private var recentOutput = ""
    private var logFile: FileHandle?
    private var baseURL: URL?
    private var pendingURL: URL?
    private var startupTimer: Timer?
    private var badgeTimer: Timer?
    private var restarts = 0
    private var quitting = false
    private var terminationReplied = false
    private var generation = UUID()

    private var logURL: URL {
        if let home = ProcessInfo.processInfo.environment["AUTOPILOT_HOME"] {
            return URL(fileURLWithPath: (home as NSString).expandingTildeInPath).appendingPathComponent("logs/autopilot.log")
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Autopilot/autopilot.log")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenus()
        makeWindow()
        UNUserNotificationCenter.current().delegate = self
        do {
            try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            logFile = try FileHandle(forWritingTo: logURL)
            try logFile?.seekToEnd()
            startWorker()
        } catch {
            showStatus("Could not open the log file: \(error.localizedDescription)")
        }
        showWindow()
    }

    private func menuItem(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func makeMenus() {
        let main = NSMenu()
        let appMenu = NSMenu(title: "Autopilot")
        appMenu.addItem(menuItem("About Autopilot", #selector(about)))
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("Settings…", #selector(settings), ","))
        loginItem = menuItem("Open at Login", #selector(toggleLogin))
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        appMenu.addItem(loginItem)
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("Hide Autopilot", #selector(hideApp), "h"))
        appMenu.addItem(menuItem("Quit Autopilot", #selector(quit), "q"))
        let appRoot = NSMenuItem(title: "Autopilot", action: nil, keyEquivalent: "")
        appRoot.submenu = appMenu; main.addItem(appRoot)

        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
        }
        let editRoot = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editRoot.submenu = edit; main.addItem(editRoot)
        let view = NSMenu(title: "View")
        view.addItem(menuItem("Show Autopilot", #selector(showWindow), "0"))
        view.addItem(menuItem("Reload", #selector(reload), "r"))
        view.addItem(menuItem("Open in Browser", #selector(openBrowser)))
        view.addItem(menuItem("Show Logs", #selector(showLogs)))
        let viewRoot = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewRoot.submenu = view; main.addItem(viewRoot)
        let windows = NSMenu(title: "Window")
        windows.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        windows.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        let windowRoot = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowRoot.submenu = windows; main.addItem(windowRoot)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windows

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "paperplane.fill", accessibilityDescription: "Autopilot")
        let menu = NSMenu()
        workerStatus = NSMenuItem(title: "Starting Autopilot…", action: nil, keyEquivalent: "")
        menu.addItem(workerStatus)
        menu.addItem(.separator())
        menu.addItem(menuItem("Show Autopilot", #selector(showWindow)))
        menu.addItem(menuItem("Settings…", #selector(settings)))
        menu.addItem(menuItem("Show Logs", #selector(showLogs)))
        menu.addItem(.separator())
        menu.addItem(menuItem("Quit Autopilot", #selector(quit)))
        statusItem.menu = menu
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Autopilot"
        window.minSize = NSSize(width: 720, height: 500)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("AutopilotMainWindow")
        let content = NSView()
        window.contentView = content
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "AutopilotDesktop/1"
        // Browser storage and workers are unnecessary: the host owns the offline/startup UI.
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor), webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor), webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        let heading = NSTextField(labelWithString: "Autopilot")
        heading.font = .boldSystemFont(ofSize: 26)
        statusText = NSTextField(wrappingLabelWithString: "Starting Autopilot…")
        statusText.alignment = .center
        statusText.isSelectable = true
        let retry = NSButton(title: "Retry", target: self, action: #selector(retryWorker))
        let logs = NSButton(title: "Show Logs", target: self, action: #selector(showLogs))
        statusView = NSStackView(views: [heading, statusText, NSStackView(views: [retry, logs])])
        statusView.orientation = .vertical
        statusView.spacing = 18
        statusView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(statusView)
        NSLayoutConstraint.activate([
            statusView.centerXAnchor.constraint(equalTo: content.centerXAnchor), statusView.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            statusView.widthAnchor.constraint(equalTo: content.widthAnchor, multiplier: 0.75)
        ])
    }

    private func startWorker() {
        guard worker == nil, !quitting else { return }
        generation = UUID()
        let current = generation
        baseURL = nil
        buffer.removeAll()
        recentOutput = ""
        showStatus("Starting Autopilot…")
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/autopilot")
        process.arguments = ["desktop"]
        var env = ProcessInfo.processInfo.environment
        env["AUTOPILOT_DESKTOP"] = "1"
        if externalWorker { env["AUTOPILOT_DESKTOP_ATTACH_ONLY"] = "1" }
        process.environment = env
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let stdin = Pipe(), stdout = Pipe()
        input = stdin; output = stdout
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stdout
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                self.receive(data)
            }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async { self?.workerExited(process, generation: current) }
        }
        do {
            worker = process
            try process.run()
            startupTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
                guard let self, self.baseURL == nil, self.generation == current else { return }
                self.recentOutput += "\nStartup timed out. Check the logs and retry."
                self.stopWorker()
            }
        } catch {
            worker = nil
            stdout.fileHandleForReading.readabilityHandler = nil
            input = nil; output = nil
            showStatus("Could not start Autopilot: \(error.localizedDescription)")
        }
    }

    private func receive(_ data: Data) {
        try? logFile?.write(contentsOf: data)
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = String(decoding: buffer[..<newline], as: UTF8.self)
            buffer.removeSubrange(...newline)
            let prefix = "AUTOPILOT_DESKTOP:"
            if line.hasPrefix(prefix), let json = String(line.dropFirst(prefix.count)).data(using: .utf8),
               let event = try? JSONSerialization.jsonObject(with: json) as? [String: Any] {
                handleEvent(event)
            } else {
                recentOutput = String((recentOutput + "\n" + line).suffix(3000))
            }
        }
        // Bound partial log lines from child processes.
        if buffer.count > 1_048_576 { buffer.removeAll() }
    }

    private func handleEvent(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "restarting": restarts = 0
        case "disconnected":
            externalWorker = true
            startupTimer?.invalidate(); badgeTimer?.invalidate()
            baseURL = nil
            NSApp.dockTile.badgeLabel = nil
            workerStatus.title = "Waiting for background service"
            showStatus(event["message"] as? String ?? "Reconnecting to the background service…")
        case "ready":
            guard baseURL == nil, let raw = event["url"] as? String, let url = URL(string: raw),
                  url.scheme == "http", url.host == "127.0.0.1", let port = url.port, (1...65535).contains(port),
                  url.user == nil, url.password == nil, url.path.isEmpty || url.path == "/" else { return }
            startupTimer?.invalidate()
            externalWorker = event["ownership"] as? String == "external"
            workerStatus.title = externalWorker ? "Using background service · Quit leaves it running" : "App manages worker · Quit stops it"
            baseURL = url
            webView.load(URLRequest(url: pendingURL.flatMap { isLocal($0) ? $0 : nil } ?? url))
            pendingURL = nil
            refreshBadge()
            badgeTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refreshBadge() }
        case "notification":
            guard let title = event["title"] as? String, let message = event["message"] as? String,
                  let rawURL = event["openUrl"] as? String, let url = URL(string: rawURL), isLocal(url) else { return }
            let content = UNMutableNotificationContent()
            content.title = title; content.body = message; content.sound = .default
            content.userInfo = ["url": rawURL]
            let request = UNNotificationRequest(identifier: event["group"] as? String ?? UUID().uuidString, content: content, trigger: nil)
            let center = UNUserNotificationCenter.current()
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                if granted { center.add(request) }
            }
        default: break
        }
    }

    private func workerExited(_ process: Process, generation current: UUID) {
        guard generation == current else { return }
        startupTimer?.invalidate(); badgeTimer?.invalidate()
        output?.fileHandleForReading.readabilityHandler = nil
        worker = nil; input = nil; output = nil
        let wasReady = baseURL != nil
        baseURL = nil
        NSApp.dockTile.badgeLabel = nil
        if quitting { finishTermination(); return }
        if (wasReady || externalWorker) && restarts < 3 {
            restarts += 1
            showStatus("Reconnecting to Autopilot…")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startWorker() }
        } else {
            showStatus("Autopilot stopped (exit \(process.terminationStatus)).\n\(recentOutput.suffix(1600))")
        }
    }

    private func stopWorker() {
        try? input?.fileHandleForWriting.close()
        guard let process = worker, process.isRunning else { return }
        process.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    private func isLocal(_ url: URL) -> Bool {
        guard let baseURL else { return false }
        return url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "")
            && url.port == baseURL.port && url.user == nil && url.password == nil
    }

    private func refreshBadge() {
        guard let baseURL else { return }
        let current = generation
        var request = URLRequest(url: baseURL.appendingPathComponent("state"))
        request.cachePolicy = .reloadIgnoringLocalCacheData; request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data, let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let count = state["awaiting"] as? Int else { return }
            DispatchQueue.main.async {
                guard let self, self.generation == current, self.baseURL != nil else { return }
                NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
            }
        }.resume()
    }

    private func showStatus(_ text: String) {
        webView.isHidden = true; statusView.isHidden = false; statusText.stringValue = text
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if isLocal(url) {
            if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
            return
        }
        let schemes = ["https", "http", "mailto", "vscode", "vscode-insiders", "cursor", "supacode", "superset"]
        if action.navigationType == .linkActivated && schemes.contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let url = webView.url, isLocal(url) else { return }
        statusView.isHidden = true; webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showStatus("Could not load Autopilot: \(error.localizedDescription)") }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        completion([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completion: @escaping () -> Void) {
        let raw = response.notification.request.content.userInfo["url"] as? String
        DispatchQueue.main.async {
            if let raw, let url = URL(string: raw) {
                if self.isLocal(url) { self.webView.load(URLRequest(url: url)) }
                else if self.baseURL == nil { self.pendingURL = url }
            }
            self.showWindow()
            completion()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        guard let worker, worker.isRunning else { return .terminateNow }
        stopWorker()
        return .terminateLater
    }
    private func finishTermination() {
        guard !terminationReplied else { return }
        terminationReplied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    @objc private func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func settings() {
        if let baseURL { webView.load(URLRequest(url: baseURL.appendingPathComponent("settings"))) }
        showWindow()
    }
    @objc private func reload() {
        if baseURL != nil { webView.reload() } else { retryWorker() }
    }
    @objc private func retryWorker() {
        if worker == nil { restarts = 0; startWorker() }
        else if baseURL != nil { webView.reload() }
    }
    @objc private func openBrowser() { if let baseURL { NSWorkspace.shared.open(baseURL) } }
    @objc private func showLogs() { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
    @objc private func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationVersion: Bundle.main.object(forInfoDictionaryKey: "AutopilotReleaseVersion") as? String ?? ""])
    }
    @objc private func hideApp() { NSApp.hide(nil) }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
            loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
            if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch {
            let alert = NSAlert(); alert.messageText = "Could not change Open at Login"
            alert.informativeText = error.localizedDescription; alert.runModal()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
