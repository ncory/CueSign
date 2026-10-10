' CueSign player for BrightSign.
' Shows index.html from the SD card full screen, with Node.js enabled so the page can
' download media to the card and play it from there.

Sub Main()
    msgPort = CreateObject("roMessagePort")

    ' Lets you open Chrome DevTools at http://<player-ip>:2999 while setting up.
    ' Takes effect after the next reboot. Remove these lines for a locked-down install.
    reg = CreateObject("roRegistrySection", "html")
    if reg.Read("enable_web_inspector") <> "1" then
        reg.Write("enable_web_inspector", "1")
        reg.Flush()
    end if

    videoMode = CreateObject("roVideoMode")
    rect = CreateObject("roRectangle", 0, 0, videoMode.GetResX(), videoMode.GetResY())

    config = {
        url: "file:///sd:/index.html",
        nodejs_enabled: true,
        brightsign_js_objects_enabled: true,
        javascript_enabled: true,
        mouse_enabled: false,
        hwz_default: "on",
        storage_path: "SD:/html-storage",
        storage_quota: 104857600,
        inspector_server: { port: 2999 },
        security_params: { websecurity: false },
        port: msgPort
    }

    html = CreateObject("roHtmlWidget", rect, config)
    html.Show()

    while true
        msg = wait(0, msgPort)
        if type(msg) = "roHtmlWidgetEvent" then
            event = msg.GetData()
            if type(event) = "roAssociativeArray" and event.reason = "load-error" then
                print "CueSign: page failed to load: "; event.message
                sleep(5000)
                html.SetUrl("file:///sd:/index.html")
            end if
        end if
    end while
End Sub
