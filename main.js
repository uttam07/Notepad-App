/* Steno — Electron shell. Loads the notepad locally, no server needed. */
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

// Single instance: focusing the existing window on a second launch
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // clean, app-like window (F12 / reload still work via shortcuts if needed)

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      title: "Steno",
      icon: path.join(__dirname, "icons", "icon.ico"),
      backgroundColor: "#f4f3f0",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });

    win.once("ready-to-show", () => win.show());

    // Open any external links in the system browser, never in-app
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });

    win.loadFile(path.join(__dirname, "index.html"));
  });

  app.on("window-all-closed", () => app.quit());
}
