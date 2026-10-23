# Dialden TV material and interaction standard

Version 1 · Native client · 21 October 2026

## Intent and scope

Content should feel like the screen; controls should feel suspended above it. Glass communicates a separate interactive layer, not decoration on every rectangle. This is Dialden's TV adaptation inspired by Apple's Liquid Glass, not a pixel-identical implementation of Apple's proprietary material. Apple’s [Materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) and [adoption guidance](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass) establish the separation between navigation and content. The numerical tokens below are our choices, not Apple specifications.

Apply this standard to Watch now, Guide, settings, details, quick guide and player controls. New components must name their layer, focus state and fallback. `src/style.rs` is the shared token source; do not create new per-screen palettes for the same role.

## Layer contract

| Layer | Material | Examples | Rules |
|---|---|---|---|
| Backdrop | Programme artwork or restrained ambient background | Home/guide background | Preserve recognisable image structure, darken behind text, avoid saturated purple/cyan dominating every screen. Never imply a still is live. |
| Content | Plain imagery, quiet translucent fill or separators | Programme cells, channel names, lists | No refraction, specular rims or repeated capsule shapes. Programme width represents time. |
| Controls | Neutral refractive glass | Navigation island, primary action buttons | Sample the backdrop, use a soft top highlight, thin rim and restrained shadow. Group related controls in one island. |
| Sheet | Dark, readable elevated surface | Details, quick guide | One enclosing surface; internal rows are content. Keep artwork visible around its perimeter. |
| Playback overlay | Near-opaque dark material | Now-playing bar, guide over video | Readability first; do not claim to blur LG hardware-plane video. |

Do not stack independent glass islands inside a glass island. The active tab is an inset selection indicator, not another floating object. Do not turn every content item into a button-shaped capsule.

## Geometry and typography

All sizes are logical pixels on a 1920×1080 canvas, scaled uniformly.

| Token | Standard |
|---|---|
| Safe edge | 80–100 px horizontally, 40 px top, 40 px bottom |
| Spacing | 8 px base; 16/24 within groups, 32/48 between groups |
| Guide cell corner | 12 px; narrow cells clamp to half their width |
| Content/sheet corner | 24 px; large sheets may use 32 px |
| Control corner | 36 px maximum, clamped to half height; capsules reserved for compact controls |
| Page title | 48–52 px bold |
| Programme/control label | 24–28 px; channel names 25–28 px |
| Supporting information | 20–24 px; never depend on tiny text for required actions |
| Text | Near white #F6F7FB; secondary #BEC4CF; focused dark text #191D24 |
| Focus fill | Pale neutral #EAEFF6 for dense content |

Keep programme titles and times aligned across rows. Truncation is allowed in short timeline cells; the selected programme summary exposes the full title when space permits. Do not compress fonts to fit more data. Avoid dividing every text fragment into its own box.

## Optical material

Glass needs a visible relationship to what is behind it: blur, mild edge distortion, neutral tint, a narrow directional rim and a soft shadow. A uniform grey rectangle with a gradient is not sufficient.

Current renderer baseline: backdrop blur sigma 14 at 960×540, neutral tint [103,110,123] at density 0.16; focused controls use a pale tint at density 0.82. Retain strong text contrast as content changes. Specular emphasis belongs at edges, never across text. No persistent neon outline or large outer glow.

These values are initial renderer tokens, not proof of perceptual accuracy. Our CPU material is a cached backdrop sample, not an optical simulation or a shader that samples the entire composited scene. Transitional surfaces currently reuse their resting sample. Plain panels now use fractional edge coverage. Dynamic backdrop response and real-TV rendering still need verification before fidelity can be claimed.

## Focus, selection and remote input

Focus is the actionable target; selected tab and currently playing channel are separate states. Only one element has primary focus. Dense guide cells use a pale fill and dark text without scaling, so time geometry stays stable. Cards may lift subtly (up to 1.025×); do not jump or cause adjacent items to reflow.

A selected but unfocused tab uses a quiet inset treatment. A playing channel gets a small persistent indicator, not focus styling. OK activates the visible focused control immediately. A hidden player bar must first reveal before OK can activate anything. Back reverses the most recent navigation step and restores focus. Future programmes open details, never unexpectedly tune another channel.

## Motion

Target 160–180 ms for focus and short transitions, 240–360 ms for sheet presentation, with continuous velocity when reversing. Launch may use the existing 600 ms entrance, skipped immediately on input. Use one shared fade/settle transition for home and guide details; keep the player’s expansion into fullscreen. Page changes finish in 180 ms. Never animate every guide cell independently or add idle shimmer. Reduced motion snaps transforms and disables decorative movement while preserving all state changes.

## Screen recipes

- **Watch now:** one image-led hero, a restrained action group, channel artwork as content. Glass is for navigation/actions, not the artwork itself.
- **Full guide:** plain channel labels, quiet 12 px programme cells, subtle row separators, clear time ruler and a thin now indicator. Navigation remains the principal glass island. One focused programme and one summary area.
- **Quick guide:** one dark sheet above playback, simple rows, Full guide as a discoverable control. Keep focus distinct from playing state.
- **Player:** programme image/video dominates; one lower controls panel, progress, now/next and concise actions. Hide controls after inactivity. Never blur or dim the video merely to demonstrate a material.
- **Details:** one readable sheet, strong title, secondary timing, compact actions. No nested glass cards for each metadata field.
- **Settings:** grouped plain rows within readable sections; glass only for navigation and actions. Visible value, focus and enabled/disabled states must be distinct.

## Accessibility and failure states

Aim for at least 4.5:1 text contrast, 3:1 large text and focus boundaries, measured against actual rendered backgrounds. These are acceptance targets; they have not yet been certified for all screens. Color alone must not convey playing, failure or selection. Required controls need explicit labels.

A reduced-transparency setting should replace glass with neutral opaque surfaces without changing layout; this setting is not implemented yet. Reduced motion already exists. Missing artwork uses the same quiet fallback palette. Loading and errors retain layout and available cached data, without flashing full-screen placeholders.

## Performance and platform limits

Never fetch, decode or blur images in the input/render path. Cache material textures; invalidate when the source changes, bound memory, and avoid continuous regeneration. TV acceptance requires measuring frame time and input latency on the target device; desktop screenshots are not performance evidence. Existing glass cache capacity is 64 surfaces.

LG's separate decoded-video plane cannot currently be sampled by this renderer. Use opaque playback materials there. Native video integration is still unfinished. Do not promise live-video refraction, decoder previews or Apple-equivalent optics from this implementation.

## Review gate

For every material change, capture Watch now, timeline, details, player and quick guide. Check dark, bright, busy and missing artwork; focus and unfocused states; long names; empty/loading/error states; reduced motion. Inspect at 1080p and typical viewing distance. Confirm labels remain legible, only controls use glass, one target reads as focused, and Back restores context. Run existing navigation tests after changes that touch component rendering/navigation boundaries.

## Adoption status

Implemented: explicit material roles, shared navigation/content/playback/details components, neutral ambient fallback, consistent focus, measured label centering, rounded-edge coverage and unified motion. See UI_REVIEW.md for the whole-client findings and verification.

Still to verify/implement: adaptive contrast and reduced transparency; real-TV motion/performance; composited-scene glass sampling. Treat these as tracked gaps, not completed features. The guide is the initial content-layer reference; the entire application is not yet visually certified against this standard.

## Alignment and naming audit

Center the navigation island on the viewport, with equal inset and tab segments. Center each tab label within its own segment using measured glyph width and visible vertical bounds. Do not use one left offset for different names. Buttons and compact status/key badges use the same centering helper; content titles and metadata remain left-aligned. Truncate before centering when a label exceeds its available width.

Use “Guide” for the main destination, “Full guide” for opening its timeline from a smaller view, and “Back” when a dialog returns to a context-dependent opener. Do not promise a particular return screen unless navigation guarantees it.

## Current-time marker

Use one small neutral glass capsule above the time ruler: “Now · HH:mm”, 164×36 logical pixels, 20 px bold text. It is an informational ornament, not a focusable button: no focus ring, hover lift, pulse or idle shimmer. Track server-adjusted time continuously; round only the displayed clock to minutes. Clamp the capsule inside the timeline at either edge, keeping the marker at its true time coordinate. Hide it when browsing a window that does not include now.

Keep the time marker confined to the ruler: no vertical track through content and no repeated per-row ticks. These were visually distracting in the animated review. A single softly feathered light bar below the capsule provides the exact position even when the capsule is edge-clamped. Keep the navigation focus independent of clock progression. The cached glass sample currently moves with the capsule (the documented moving-surface approximation), avoiding per-frame material regeneration.

Visual regression scenario: browse channels, advance to future programmes, open details, return, and cross a programme boundary while the time marker moves. `--demo --timeline-flow --motion-preview DIR` compresses 45 minutes into nine seconds (300×), labels the simulation, and exports 10 fps frames from a 30 fps simulation. This does not change live server time or demonstrate TV rendering performance. Repeat with `--reduce-motion` to confirm the same navigation and clock state without decorative motion.

### Programme-details sheet reference

Use the explicit `Glass::sheet` material: 32 px rounded corners, neutral dark tint, restrained rim and cached blurred backdrop. Do not use a plain blue panel for this dialog or infer sheet material from rectangle dimensions. Center a 1020×564 surface in the viewport with 60 px content insets; align the channel, title, timing, episode and status to one left edge. Allow two lines for the title. One compact 300×73 return button sits on that same edge; its label is centered. Dim the surrounding guide moderately, keeping its context visible. Home and guide details share this sheet material.

### Status spacing and soft light bar

The guide reserves independent vertical bands: subtitle at y=246, Now capsule at y=294 (height 36), light-bar center at y=338 (halo limited to ±6 px), ruler labels at y=360, programme rows starting at y=406 with 100 px spacing. The indicator must never collide with the subtitle or ruler labels. `style.rs` owns these values and a layout test protects their clearance.

`components::now_indicator` owns the label, glass treatment and light bar. The bar is 48 px wide at most, with a narrow core and a low-opacity desaturated teal halo. Clip it to the timeline bounds. No pulse, persistence or trail; no row markers. Focus remains visibly stronger. A future increased-contrast setting should replace the halo with a crisp underline; that setting remains unimplemented.

### Reference adoption

The [AppKit implementation reference](https://github.com/artemnovichkov/xcode-27-system-prompts/blob/main/AdditionalDocumentation/AppKit-Implementing-Liquid-Glass-Design.md) informs our use of reusable material components, grouped controls, centered labels and restrained tint. Its AppKit APIs are not portable to our Rust/SDL renderer. Our implementation points are `button`/`Paint::centered`, `Glass::sheet`, `components::now_indicator`, and shared style tokens. Treat these as the required reuse points; do not recreate their appearance inside a screen. Navigation is now a shared component; `Material` explicitly distinguishes controls, focused controls and sheets. The soft time bar is a Dialden design choice, not a prescription from the reference.

## Whole-client consistency review

See [UI_REVIEW.md](UI_REVIEW.md) for findings and verification. Home cards use 24 px corners; dense rows/cells use 12 px. Both use matte content fills and the same pale focus treatment. Navigation has one glass enclosure and an inset active indicator. Playback controls and quick-guide actions share opaque button styling appropriate to LG video overlays. Home/guide details share a cached component, 145/255 scrim, compact return action and critically damped fade/settle. No draggable handle appears on the remote-operated guide. Numeric badges use measured centering. Headings overflow to a second line with ellipsis instead of silently dropping text.

## Reuse contract for programme browsing

Use `components::channel_guide_row` for every channel / On now / Up next list. Both the page and playback overlay call this component: channel column, show heading, episode subtitle, Playing state, focus colour and truncation must not be independently recreated. The surrounding sheet may change material for playback readability; row semantics remain identical. Reuse the navigation island for top-level tabs; do not introduce a second tab treatment on a guide surface.

The full guide retains time-proportional cells because their width conveys duration. It shares programme labels, content focus styling and `components::details` with the other surfaces. All programme details use this same centered sheet and open/close motion, including reduced-motion behavior. New browse surfaces must reuse these components or extend them for all callers.

Display hierarchy: show/movie title → schedule status/time → episode number and title → available rating with region and first-air date → description. Omit unavailable facts. Episode descriptions take precedence over collection descriptions; a TV collection fallback is labelled “About the show.” Never substitute fabricated synopsis text or treat a collection rating as an independent episode rating. Missing descriptions say “No description available.” Station assets never expose filenames as episode information.

The server supplies cached library metadata in schedule responses. Opening a sheet must not trigger a provider request. Keep the current 30-second catalogue refresh and 120-second visible-guide refresh; preserve cached guide rows when a refresh fails. Old servers without the optional metadata object remain supported. Artwork continues through the existing server still/cache path, independent of text metadata.

Verification for a new surface: populated and missing metadata, long title/description, movie versus episode, focus movement, Back returning to the previous selection, and reduced motion. Demo content must be labelled as sample data.

## Launch and transition lifecycle

Startup uses a centered Dialden wordmark, a small glass tuning mark and a quiet connection message. Only the mark animates while waiting: a slow wave, never a percentage or a promise about remaining time. The first catalogue response releases startup immediately, including an empty catalogue; artwork is not a readiness dependency. Connection failure also releases startup into the connection/empty state. Background refreshes never replay the splash. Back opens connection details while the request continues.

The loading surface fades away over 360 ms as the destination settles in with the existing 600 ms launch easing. Subsequent page entrances use 180 ms; channel expansion, playback bar, guide sheet and details retain the shared critically damped spring. Re-render destination content during a page entrance so guide replies, artwork and sheet motion do not freeze in a captured frame. Remote input bypasses ready-state decoration. Reduced motion disables the tuning wave, entrance transforms and launch fade.

Run `--demo --loading-flow --motion-preview DIR` to exercise waiting → home → channel preview → quick guide → Back → home. The preview simulates readiness after 1.5 seconds solely to make the handoff visible; production has no artificial wait.

### Calm ambient loading treatment

The launch background uses broad, low-contrast pearl and slate-blue light fields. Drift is bounded, with a 24-second horizontal cycle and a 48-second vertical cycle; brightness does not pulse. Typography and controls stay stationary. The small tuning mark moves slowly with only 12 px of height variation. Avoid saturated auroras, fast equalizer motion, particle effects and moving text on this surface.

The light field is generated once and cropped during rendering; no per-frame blur or image generation is permitted. Reduced motion fixes the crop and the tuning bars. Preview sustained motion with `--demo --ambient-flow --motion-preview DIR`; this demo-only mode deliberately holds the loading surface for 12 seconds. Production readiness behavior is unchanged.

### Browse backgrounds and quiet connection access

Watch now, Guide and Settings share the calm ambient background. With programme artwork available, only the dimmed backdrop drifts gently inside a small overscan; foreground artwork, cards and text stay fixed. Without artwork, use the same soft light field as startup. Use one continuous animation clock across page transitions; do not restart the drift on focus changes. Reduced motion freezes both variants.

Routine startup uses the tuning animation without a “Loading channels” label. Only a wait longer than eight seconds adds a discreet “Still connecting…” explanation. Connection access is a small glass control: Down focuses, Up leaves focus, OK opens Settings when focused, and Back always opens Settings during initial loading. Keep it visually secondary; no large footer sentence. Cached glass uses the same neutral backdrop palette, without regenerating material textures each frame.

### Curved ribbon and tuning refinement

The ambient field now has a single broad curved horizon/ribbon with a soft luminous crest, restoring the original space-like shape. It replaces the diffuse glowing areas while retaining slow bounded drift and a dark slate-blue palette. Share this field between launch and browsing fallbacks.

The logo and wordmark stay static. All five antialiased logo bars remain 34 px tall. The ribbon supplies the ambient movement. Separate, small activity dots fade in below the wordmark only after three seconds of initial connection time; they become fully visible over 500 ms. Reduced motion uses stationary dots. After eight seconds, retain the discreet connection explanation. Never animate the brand mark to communicate network activity.

### Flowing ribbon geometry

The latest ambient treatment bends along its length rather than panning a fixed image. Two restrained translucent ribbons overlap, with travelling waves changing their centreline and width at different rates. A soft luminous fold provides definition. This is an original PS3-inspired flowing-ribbon treatment, not a reproduction of console assets. The logo stays static, and the delayed activity indicator remains separate.

Render the ribbon using two fixed-size 96-segment meshes and a cached soft strip texture. No per-frame image generation, blur or texture upload. Reduced motion freezes the mesh at its initial shape. Apply the wave to startup and browse screens without programme artwork; keep the existing subtle movement of real programme backdrops. Keep the wave below the primary title area and preserve text contrast.

### Wordmark-only launch composition

The current launch screen replaces the icon treatment described above with the Dialden name and a tagline directly below it. Do not render the glass badge or tuning bars. Keep the text group slightly above centre, with the flowing ribbon behind it, delayed activity dots below it and the small Connection control near the bottom edge. The name and tagline stay stationary.

## First-launch setup

Use the shared flowing background with a two-column page: explanation on the left, grouped interactions on the right. Setup is not a centered modal. Icon-led choices share one enclosure and highlight only the focused row; Local/Remote uses a single segmented control. Reuse inset controls, content rows and remote focus treatment. Avoid oversized standalone buttons or nested glass islands. Keep discovery, manual input, testing, failure and success within the same spatial frame. Retain the address through error/cancel paths; make manual entry accessible while searching and after no results. The selected local/remote mode must be identifiable separately from focus. Keyboard focus follows its visible rows and columns. Setup demo states must carry a persistent simulation label and must never imply a real connection was made or saved. See `SETUP_FLOW.md` for the flow contract.


### State-change motion contract

A status update is not page navigation. Discovery → results, testing → success/error and validation changes keep the wordmark, background, page anchors and remote hints stationary. Never replay the whole-page zoom/entrance for these updates.

- Stable anchors, flexible dimensions: keep the interaction enclosure’s top edge and width fixed across discovery and connection outcomes, but size its height to actual content. Never reserve empty rows for potential results. A two-row search group grows downward when results introduce another row and shrinks when choices are removed.
- Preserve shared controls by semantic identity. Interpolate their positions with the container; keep them visible instead of fading the whole contents away. Reveal inserted rows only within the space that has opened, after outgoing rows clear. Keep the page narrative fixed. Fade only replaced form content (100 ms out, 200 ms in); never blank the entire panel. Do not slide an entire page for an asynchronous result.
- Interpolate enclosure bounds and shared row positions together over 300 ms with smoothstep easing and no bounce. Forms and keyboards can also resize their enclosure. These are Dialden timing choices, not Apple-prescribed constants. Keep continuous background motion independent.
- Do not morph unrelated button meanings into each other. Preserve semantic actions and their anchors where possible (Enter an address retains its identity through welcome, search and results; the selected server remains identifiable while connecting). The incoming stage owns focus and input immediately; another remote input settles decorative motion before acting. Keep only one outgoing snapshot, with no animation queue.
- Reduced motion changes state immediately, with no fade or resize interpolation. Texture allocation failure also falls back to usable immediate content.
- Use directional slides only for real spatial navigation with a clear forward/back relationship. Reserve shared-element morphs for the same object, such as a selected channel expanding into playback. They are not the default for buttons or status text.

The setup implementation uses one reusable transparent content texture, a single persistent glass enclosure and the shared background. Test discovery success/empty, connection failure/success, keyboard opening/closing, rapid remote input and reduced motion. Full-page entrance remains appropriate for leaving setup and entering Home.


Reference: Apple’s [Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) describes continuous shape changes and material adaptation as controls expand. [Custom Liquid Glass views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views) documents coordinated geometry and materialization. [Motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion) calls for purposeful, brief, interruptible motion. Our SDL implementation adapts these principles; it does not reproduce Apple’s native lensing/materialization APIs. Do not label an opacity animation alone as equivalent to the system Liquid Glass effect.


### Setup focus and activity

Busy states do not automatically focus an unrelated fallback action when the initiating button disappears. Show a quiet three-dot opacity wave (approximately 2.9 seconds per cycle) in the status row; reduced motion uses static dots plus readable status text. Directional input deliberately focuses Enter an address or Cancel. Repeated OK while busy must not unexpectedly open options or cancel a connection. A discovery result selects Connect only if no alternative action was deliberately focused; otherwise retain Enter an address by identity. Returning from Other options restores its focus.

For a single discovered server, show its identity separately from the primary Connect action. Keep Enter an address directly accessible across welcome, search and results. Other options is a separate results action; it must not replace or relabel manual entry. After successful connection, retain the server identity and enter Home following a brief confirmation, without another Open Home/Choose another server decision. This is a simulated single-server flow; production discovery still needs a multiple-server selector and saved-server integration.


### Setup is one workspace

Keep the setup title and introduction identical across discovery, results, options, manual entry, testing, success and failure. Render these outside all transition textures. Status, errors and next actions belong inside the interaction panel; do not restate them as a new page headline. Only leaving setup for Home is page navigation.

Other options expands within the same panel, retaining the server identity (or paused search context) above the available methods. Closing options restores the parent selection. Manual entry keeps the panel’s top edge and width, and Back returns to the originating options. During keyboard opening/closing, the address field and connection-mode controls remain fully visible; animate only the changing lower region. Never fade the entire form to expose a keyboard.

Review paths: welcome → search → found → connect → Home; empty search → retry/manual; found → options → manual → keyboard → Back → options → found; connection failure → retry/edit; saved-server failure; reduced motion and repeated remote input. `--demo --setup-review --motion-preview DIR` exercises the options/manual/keyboard/back loop and then connects. Discovery and connection remain fixtures.


### Entering the connected server

After a successful connection, give setup a single welcome handoff: its content recedes over 250 ms, the server name appears with “Your channels are ready” over the uninterrupted ribbon, then Home settles in. Use the existing 800 ms connected confirmation for this welcome rather than adding a second waiting screen. No percentages or implied network progress.

Home enters as transparent content groups over the live background: navigation, featured programme, channel-row heading, then channel cards with 45 ms offsets. Each group uses a monotonic 650 ms ease-out and a small vertical rise (12–30 px). Complete the Home entrance within 1.15 seconds. Keep the server label briefly visible as Home begins, then fade it. Do not animate a flattened backdrop or replay this ceremony for tabs, refreshes, guide openings or channel changes.

Remote input bypasses Home entrance decoration immediately. OK skips the connected confirmation; Back returns to server selection. Reduced motion uses the inline connected state and immediate Home without spatial choreography. Render Home into one reusable transparent target during the entrance; reuse its non-overlapping regions instead of allocating a texture per card. This is an original TV-oriented welcome, not a claim of reproducing tvOS system animation.


Starting discovery updates only the discovery row to its busy state. Enter an address retains its label, subtitle, icon, row position and direct action throughout that transition; do not crossfade it into an options menu. Preserve its focus when discovery completes. Additional result actions may enter as separate controls without taking over an existing control’s identity.


### Top-level tabs and Settings

Watch now, Guide and Settings share stationary navigation, wordmark, clock and background. A tab switch fades/settles only content below the navigation (180 ms, 12 px maximum rise); do not zoom the whole screen. The shared inset tab indicator uses the existing monotonic spring to move between labels. Update it once per frame, including during content transitions. Reduced motion settles the indicator and content immediately; rapid remote input does not queue animations.

Settings groups Connection, Appearance and About with clear section labels. Connection values are informational, not imitation buttons. Appearance uses the shared focused-row treatment for the functional Reduce motion control: Down/OK from the tab enters it, OK toggles, Up/Back returns to navigation. State explicitly that the choice lasts for this session; persistence is not implemented. Keep explanations and controls visible in place when the setting changes. Selecting reduced motion immediately cancels an active entrance.

`--demo --tabs-flow --smooth-preview --motion-preview DIR` records Watch now → Guide → Settings, enters the motion control, toggles it on/off, and returns through Guide to Watch now. This is a preview catalogue; no TV deployment is implied.


### Transparent animation compositing

A transparent render target already contains premultiplied RGB after drawing translucent panels into it. Composite it with ONE / ONE_MINUS_SRC_ALPHA rather than applying source alpha a second time. Fade premultiplied layers by modulating both RGB and alpha together. Otherwise panels are too faint during motion and visibly pop to their correct opacity when direct rendering resumes.

The shared entrance compositor uses SDL custom blending when supported. On renderers without that capability (including the software preview renderer), convert the short-lived target to straight alpha in a reusable streaming texture. This fallback performs a readback during the transition; the supported GPU path does not. Validate final animation frames against direct rendering, especially low-opacity cards, rounded edges and glass controls. The same rule applies to tab content transitions.


### Remote navigation help

Watch now, Guide and Settings must use `components::navigation_help`, including empty-guide states. Share the bottom baseline, rounded key badges, typography, spacing and right-aligned status note; never replace this with a plain-text instruction sentence. Labels follow actual focus: tabs versus guide grid versus Settings controls. The guide identifies OK as Open channel for the current programme and Details for other entries. Keep accelerated-demo information in the status area rather than mixing it into control instructions. The in-player quick guide uses the same key badges through `components::navigation_help_at`, positioned inside its moving sheet. Show each remote action once: programme summaries contain title and time, while OK instructions belong only in the shared footer.

## Live video surfaces

Home previews wait 700 ms after focus settles, are muted, and use one decoder. OK promotes that decoder into the existing player entrance with audio, without another load. Quick-guide focus must not retune until OK. Show representative stills while waiting and keep connecting/buffering/error messages readable above them. Never label a still as decoded video. Fit video without cropping or stretching; browsing glass continues sampling artwork; desktop playback controls sample decoded video. Demo/export flows never initiate playback. The desktop software renderer does not validate the LG video-plane path.

## Playback chrome revision

Use the compact 1560×194 now-playing surface and 636×62 top navigation. Desktop playback surfaces use `Glass::live_sheet`: a blurred, tinted sample of the decoded frame with a restrained rim, refreshed at most 5 Hz while controls are visible. Use bilinear scaling for the small optical layer. The quick guide reuses that material. Do not use an almost opaque navy block for either surface. On a separate hardware video plane, retain translucent fallback tint until a supported sampling path exists.

Routine connecting/buffering uses the small shared three-dot activity ornament after 600 ms; brief waits show no banner. Terminal failure messages are separate from activity and stay actionable. Up/Down changes channel directly even with hidden controls; Left/Right chooses a control, and OK reveals hidden controls before activating one. Preserve one muted preview when focus moves to the home tabs or programme details.

## In-channel controls and loading

When the player menu is visible, Up/Down follows its vertical button arrangement. Left/Right switches to the previous/next channel whether controls are visible or hidden; it never changes button focus. OK activates the focused action. Back first dismisses the controls, then a second Back returns to the originating browse/guide page. When controls are hidden, Up/Down changes channel; dedicated channel buttons change channel regardless of menu visibility. OK reveals the controls with Channels focused. Pointer motion reveals controls and renews their idle timer; a click on a hidden menu reveals it before activating anything.

Routine stream loading uses three small, softly pulsing points with no plaque or waiting headline. Delay their appearance for 600 ms to avoid flashes during quick switches; respect reduced motion. Keep the player menu hidden during loading. A missing still uses the same dark neutral canvas as the app. Playback errors remain explicit and actionable. The demo-only `--fixture tuning --screen player` renders this state without network playback.

### Menu audio
Use original, low-volume cues: a 42ms cushioned focus tap, an 80ms slightly brighter selection, and a 65ms lower, softer back tap. Use a quick smooth attack, warm resonant body, subtle filtered texture, and short decay; avoid audible pitch sweeps, melodies, and notification-like chimes. These are original sounds, not sampled Apple assets. Fade both ends to avoid clicks. Trigger only on user actions that change state; background refresh, pointer hover, and focus boundaries stay silent. Rate-limit movement and bound queued audio. Menu and launch sounds can be disabled together in Settings (session preference). Never alter programme volume to play cues. Audio initialization failure must leave navigation usable and log a diagnostic. TV mixing and perceived loudness require a listening check before considering the sound design final.

The launch cue is one 720ms soft wave with a smooth swell and fade, played as the first ready home screen enters. Never replay it on periodic catalog refresh, channel tuning, or window restore. Suppress it in screenshots and motion previews.

The player overlay uses a compact 154px floating dock, rounded controls, a fine optical rim, and a small directional hint. Show current channel, programme, episode, progress, and next programme. Preserve contrast over bright footage: native TV video is composited beneath a translucent dark material, not falsely described as a sampled live blur. Pointer targets must follow the visible control bounds.

### Home preview and station artwork
Keep channel and programme text beside the preview, not repeated inside its loading placeholder. Center the same quiet activity dots in the preview while waiting; show a single failure/off-air message when appropriate. Channel cards prefer server-provided transparent PNG icons, fitted without stretching, with readable channel-name fallbacks. Download icons on a separate worker and retain them across catalog refreshes; unavailable artwork must never block navigation or tuning.

The Watch now hero leads with the show title, then episode number/title and a maximum three-line synopsis. Do not repeat the station name or LIVE badge above it: the channel row identifies the selection. Prefer an episode synopsis, label show-level fallback as “About the series”, and never invent an episode description when metadata is absent.

With episode information visible in the home hero, Full guide is its single action. Do not add a duplicate Programme details button; remote OK and pointer activation both open the guide.

Guide performance: prefetch the current schedule while the visible app is on another page, retain cached rows during background refresh, and cap concurrent requests. Animate a captured incoming tab surface rather than rerendering its entire grid every transition frame. Normal page motion lasts 180ms and never delays input. Keep rounded surfaces efficient by drawing flat middles as rectangles and only tracing curved edges.

At the home navigation root, Back opens a centered quit confirmation. Default to Stay; Back cancels, and quitting requires explicitly selecting Quit and pressing OK. Pointer input is confined to the confirmation while open. Exit through normal application teardown so playback and presence sessions can close.

Keep the viewing footer quiet during normal operation: do not show a persistent Connected badge. Connection details belong in Settings; use the footer for actionable offline/reconnection state while cached content remains visible.
