# First-launch connection design

This is an interactive native UI demo. Discovery, saved-server state and connection outcomes are simulated; it does not search the network, send the entered address to a server, or persist it. A persistent footer identifies the simulation. Existing real `--server` startup is unchanged.

## Flow

- First launch: wordmark/ribbon entrance → setup welcome.
- Welcome: Find a local server or Enter server address.
- Search: a slow three-dot activity wave, with Enter an address kept in the same row as on the welcome screen. No fallback action is initially focused; a directional key deliberately focuses it. If manual entry is focused when results arrive, it keeps focus and still opens the address form directly. Results never trigger an automatic connection.
- Results: the single-server demo presents the server name and address, a primary Connect action, the preserved Enter an address action and secondary Other options. Other options expands Search again, Enter an address and Close options beneath the retained server identity. Back restores focus to Other options.
- No results: explain that the server must be running on the same network; provide retry and manual entry.
- Manual: Local network / Remote server choice, address field, remote-friendly on-screen keyboard, Test connection and Back. A physical keyboard also works. Remote mode expects HTTPS. Address syntax is checked with the existing validator before the simulated test begins.
- Connection test: visible address and Cancel. Cancelling retains the address for editing.
- Failure: preserve the address; offer Try again, Edit address, and Find a local server.
- Success: retain the selected server, show a brief server-name welcome over the ribbon and begin Home automatically after 800 ms; OK can skip the confirmation and Back returns to the result. The surrounding demo remains labelled as simulated; no address is saved. Home navigation, feature and cards enter in a short staggered sequence, skipped by remote input or reduced motion.
- Returning launch: the saved-server fixture tests the saved address, then exposes the same failure/recovery choices if unavailable.

## Interaction and material

Setup is a full page over the continuous ribbon: a stable explanation column on the left and one compact interaction group on the right. Icon-led choices share a single enclosure, with an inset highlight only on the focused row. Manual entry groups Local/Remote into one segmented control above the address and keyboard. Avoid an enclosing modal or a stack of oversized independent buttons. Focus is distinct from the selected Local/Remote mode. Status changes keep the page and enclosure top edge anchored while height follows actual content over 300 ms. Shared actions remain visible and move with the layout; new rows appear within the opening space. Search has no empty reserved row. The selected server retains its name during connection. The page heading and introduction remain fixed. Only replaced form content fades through; manual-form and keyboard bounds also resize over 300 ms. The address and mode controls remain visible while the keyboard opens. Only entering Home uses the shared page entrance. Reduced motion applies the destination immediately; remote input settles decorative motion before acting. See the state-change motion contract in `LIQUID_GLASS_STANDARD.md`. Back closes the keyboard first, then returns to the options that opened manual entry. Text remains in the field when editing is cancelled.

## Visual reference

The reference is the PlxNative LG client, specifically its sign-in screenshot and native onboarding/table layout in the [PlxNative repository](https://github.com/GLinnik21/plx-native). The adopted principles are a page rather than a modal, narrative beside grouped content, restrained leading icons and compact secondary actions. Dialden retains its own server discovery flow and original Rust/SDL drawing code; Plex account linking and reference assets are not incorporated.

## Try it

From `clients/native`:

```sh
cargo run -- --demo --screen setup
cargo run -- --demo --screen setup --setup-result empty
cargo run -- --demo --screen setup --setup-result error
cargo run -- --demo --screen setup-saved
```

Static states: `setup`, `setup-searching`, `setup-found`, `setup-empty`, `setup-manual`, `setup-keyboard`, `setup-error`, `setup-connected`, `setup-saved`, `setup-options`.

```sh
SDL_VIDEODRIVER=dummy cargo run -- --demo --setup-flow --motion-preview /tmp/dialden-setup
```

The scripted 10.5-second walkthrough covers launch → welcome → local search → result selection → test → brief success → automatic Home. Default output is 10 fps; `--smooth-preview` exports 30 fps. `--setup-result empty|error` switches the interactive fixture outcome. The saved-server fixture intentionally fails so recovery can be reviewed.

## Production integration still required

Implement actual server discovery and a cancellable connection worker behind this state model. Verify Dialden identity and usable channel responses before offering success. Add explicit outcomes for authentication required, TLS/address failures and incompatible server versions. Retain manual entry when discovery is unavailable. Persist the verified selection only after success, then reconnect on the next launch without rediscovery when possible. Never replace a working saved selection with an unverified address. On-TV keyboard/remote behavior and network permissions require device validation before release.


## Flow review preview

`SDL_VIDEODRIVER=dummy cargo run -- --demo --setup-review --motion-preview /tmp/dialden-setup-review`

This 17-second scripted review searches, opens Other options from the result, enters the manual form, opens/closes the keyboard, returns through options to the server, connects and enters Home. The same setup headline and panel anchors remain throughout. Empty and failed outcomes have explicit inline explanations. The saved-server fixture remains available for recovery checks.
