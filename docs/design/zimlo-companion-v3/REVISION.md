# Companion V3 — revision preparation

Status: NOT written to Figma. The first V3 mutation was rejected by the Figma MCP Starter tool-call limit. Preserve existing V2 frames and user edits. Original editable file: https://www.figma.com/design/TkuqXPEDme29bh1jsWEANg

## Verified V2 problems

Readback: iOS header 3:93 is 163 px high, plus 16 px top padding and 24 px spacing. Profile 2:8 incorrectly contains Composer 3:200, plus message prompt text 3:201 and send controls 3:202. Mac header is also 163 px high. These are actual nodes, not inferred from screenshots.

## V3 screen inventory

Create a separate page: V3 · Compact companion. Keep V2 untouched.

- Mac conversation, 1120 × 820: compact 64 px header, roomy centered conversation, inline work artifacts.
- Mac profile, 1120 × 820: independent settings/content page; no composer.
- iOS conversation, 393 × 852: 24 px system status + 64 px compact header.
- iOS result and action confirmation, 393 × 852.
- iOS profile, 393 × 852: independent page, no composer or chat messages.
- iOS avatar selector, 393 × 852: six companions in a two-column grid, selected outline/check, Cancel and Save actions.
- Message styles component sheet: all six families below, with real reusable components and editable text.
- Avatar series sheet: six editable vector companion components, separate from app icon.

## Six message families

1. Conversation: assistant neutral soft bubble and Kai pale green bubble; variable width, concise paragraphs.
2. Media: image preview or compact file attachment row, filename/type/size and open action.
3. Progress: collapsed by default, one line with status and disclosure; details only when expanded.
4. Result: concise outcome plus inline artifact links and optional proof; do not wrap every sentence in a card.
5. Action confirmation: distinct action, scope and meaningful impact, explicit Allow once/Decline actions; separate from conversational prose.
6. System notice: low-emphasis centered text for connection or session changes; no speaker avatar and no large bubble.

## Compact chat header

One horizontal row: 36 px selected companion avatar, name with compact status, activity action, profile action. On iOS use 44 px action targets. Remove centered large avatar, tagline and vertical identity stack from chat. Mac uses same hierarchy at desktop scale. Large 80–96 px avatar appears only on profile/selector. Avatar is user-selectable identity artwork, not application icon.

## Profile structure

Back navigation and page title; large selected companion with Edit avatar; name/bio Edit action; remembered context with Review/Edit/Clear controls; connected devices and permission controls; integrations/runtimes; notification/privacy settings. No bottom chat input and no conversation content. Real example data remains labeled as illustrative, not actual memory or device state.

## Avatar series

Six distinct silhouettes: Sprout, Bud, Moss, Mushroom, Pod, Cloudleaf. Shared 96 px canvas, soft muted fills, dark two-eye face and gentle curved smile. Each supplied SVG is editable vector source, not a color-swap app icon. Selection is a separate UI treatment; avatars themselves contain no app badge or navigation affordance.

## Validation required after resuming

Read back new page IDs, actual message-component inventory, header height and 44 px targets. Assert profile has zero Composer nodes, zero send controls and zero conversation bubble instances. Inspect all avatars as distinct editable vector components. Check no whole-screen raster fills. Verify Mac and iOS conversation, profile, selector and style-sheet screenshots before claiming V3 completion.

## Typography

V2 native SF Pro rendered invisible in the connector; Noto Sans SC was verified as visible. Reuse this fallback for review, while native implementation should preserve semantic system fonts/Dynamic Type.
