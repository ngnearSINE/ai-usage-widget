# Changelog

What's new in each version of AI Usage Widget. When the app is set to English, these notes appear in the About & updates window, and they're added below the Korean notes on the GitHub Releases page.

Korean notes: [CHANGELOG.md](CHANGELOG.md)

## 1.8.0

- **Apps started with extra accounts are found automatically**: if you run the Claude desktop app or Cursor with a separate data folder (`--user-data-dir`) per account, those profiles show up as cards with nothing to set up. Same-name folders next to the default one (such as `Claude-Account2`) are found right away; a profile elsewhere is found within 2 minutes while the app runs with it, and stays checked after the app closes. Profiles are recognized by the sign-in inside the folder, not its name, so profiles made by any launcher or shortcut work. The same account shares one card.
- **Multiple Cursor accounts**: Cursor gets a card per signed-in user across its profiles (when you use a Cursor card).
- **Add an account from a folder**: under Settings → Services → **Add an account from a folder**, choose a folder and the app works out whether it's an app profile, a parent folder holding several profiles, or another Codex·Grok·Claude Code login folder, and adds it the right way. A parent folder keeps being checked, so profiles added later are found too.
- **Managing app profile folders**: the collapsed **App profile folders** section in Settings → Services shows the profiles found and where, with a switch per profile, removing folders you added, and **Deep search** to scan your whole user folder.
- **Double-click the tray icon to find the window**: it shows the window (the dock in dock mode) and the whole window flashes softly once. A hidden window comes back too. Turn it off with **Show where the window is on tray double-click** under Settings → Display → Window.
- **Lighter Cursor checks**: Cursor's state file, which can be hundreds of MB, is only read again when it changes.

## 1.7.1

- **Stays on top of full-screen apps**: with Always on top turned on, the window no longer slips behind another app's full-screen view such as a video or game. If a full-screen app covers it, it comes straight back to the front without taking focus from that app. It doesn't cover Windows screens such as Start or Task View. (Games running in exclusive full-screen mode take over the display, so no window can appear above them.)
- **Turning off Always on top takes effect right away**: fixed a case where it could briefly act as if it were still on just after you turned it off.

## 1.7.0

- **English support**: the app now comes in English. On first launch it starts in English unless the Windows display language is Korean (on Linux it follows the system language). Switch anytime from **언어 / Language** in the ☰ menu, the tray menu or at the top of Settings → Display; every window changes right away, no restart needed. An English README and an English user guide (PDF) are included.
- **The window no longer disappears on its own**: it goes away only when you hide it with Hide to tray, the show/hide shortcut or the tray menu. If Windows minimizes it, it comes straight back without taking focus from what you're typing in.
- **Hiding for full-screen apps is now a setting**: hiding the window while a full-screen app is open on the same monitor is now off by default. Turn it on with **Hide while a full-screen app is open** in Settings → Display → Window.
- **Show/hide shortcut**: pressing it while the window is minimized brings it right back.
