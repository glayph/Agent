# UI verification

The former bundled browser-driver UI harness has been removed. Miki does not install or launch a private browser for application automation.

Use the Miki Browser Agent extension in the user's Chrome/Edge/Brave/Opera/Vivaldi or Firefox browser, pair it using the authenticated `/api/browser/bridge` endpoint, and execute UI checks through `browser_*` tools. For platform-wide app testing, use `computer_capabilities`, `computer_observe`, `computer_invoke`, and `computer_verify`.

The Gateway E2E script (`npm run test:live-e2e`) now checks the authenticated HTTP/API and browser-bridge pairing contracts. It intentionally does not claim a live visual browser test unless a paired browser is used on the target machine.


## Scope boundary

UI verification checks the frontend source and generated/build-time contracts available to this script. It does not replace an actual browser review of responsive layout, keyboard interaction, Gateway connection transitions or confirmation dialogs. After changing the Chat Top Bar, pair this check with the frontend tests, lint, production build and a manual desktop/mobile pass. See `docs/structure/07-ui-dashboard.md` for the relevant source files.
