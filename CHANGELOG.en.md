# Changelog

What's new in each version of AI Usage Widget. When the app is set to English, these notes appear in the About & updates window, and they're added below the Korean notes on the GitHub Releases page.

Korean notes: [CHANGELOG.md](CHANGELOG.md)

## 1.7.1

- **Stays on top of full-screen apps**: with Always on top turned on, the window no longer slips behind another app's full-screen view such as a video or game. If a full-screen app covers it, it comes straight back to the front without taking focus from that app. It doesn't cover Windows screens such as Start or Task View. (Games running in exclusive full-screen mode take over the display, so no window can appear above them.)
- **Turning off Always on top takes effect right away**: fixed a case where it could briefly act as if it were still on just after you turned it off.

## 1.7.0

- **English support**: the app now comes in English. On first launch it starts in English unless the Windows display language is Korean (on Linux it follows the system language). Switch anytime from **언어 / Language** in the ☰ menu, the tray menu or at the top of Settings → Display; every window changes right away, no restart needed. An English README and an English user guide (PDF) are included.
- **The window no longer disappears on its own**: it goes away only when you hide it with Hide to tray, the show/hide shortcut or the tray menu. If Windows minimizes it, it comes straight back without taking focus from what you're typing in.
- **Hiding for full-screen apps is now a setting**: hiding the window while a full-screen app is open on the same monitor is now off by default. Turn it on with **Hide while a full-screen app is open** in Settings → Display → Window.
- **Show/hide shortcut**: pressing it while the window is minimized brings it right back.
