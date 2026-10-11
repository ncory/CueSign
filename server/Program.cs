using CueSign.Server;

// The headless server, for a Raspberry Pi, a Linux box or running as a service.
// On a Mac or Windows desktop the tray app in ../app runs this same server.
ServerHost.Build(args).App.Run();
