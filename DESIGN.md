---
# gstack: design-md-format=spec
name: Agent Ledger
description: A filed instrument. White paper, iron-gall ink and ruled fields; sober, precise and traceable, like a court exhibit or an auditor's report, never a SaaS screen.
colors:
  paper: "#FFFFFF"
  surround: "#EEF0EE"
  ink: "#1B2733"
  ink-muted: "#4A5866"
  rule: "#C9D0CC"
  rule-strong: "#9AA69F"
  seal: "#8C6A1E"
  human-approval: "#7A1F2B"
  exception-tint: "#F6F1EA"
typography:
  display:
    fontFamily: Source Serif 4
    fontWeight: 600
    fontSize: 2.75rem
    letterSpacing: -0.005em
  heading:
    fontFamily: Source Serif 4
    fontWeight: 600
    fontSize: 1.625rem
  body:
    fontFamily: Source Serif 4
    fontSize: 1.0625rem
    lineHeight: 1.55
  label:
    fontFamily: IBM Plex Sans Condensed
    fontWeight: 600
    fontSize: 0.78rem
    letterSpacing: 0.01em
  table:
    fontFamily: IBM Plex Sans Condensed
    fontSize: 0.9rem
    fontFeature: tnum
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.84rem
    fontFeature: tnum
rounded:
  none: 0px
  seal: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
components:
  integrity-block:
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.none}"
  verification-seal:
    borderColor: "{colors.seal}"
    textColor: "{colors.seal}"
    rounded: "{rounded.seal}"
  human-approval-mark:
    borderColor: "{colors.human-approval}"
    textColor: "{colors.human-approval}"
    rounded: "{rounded.none}"
  table-header:
    textColor: "{colors.ink-muted}"
    borderColor: "{colors.ink}"
  exception-row:
    backgroundColor: "{colors.exception-tint}"
---

# Agent Ledger

## Overview
The one thing to remember: **this is real evidence.** Agent Ledger's evidence pack should feel like a filed,
tamper-evident instrument an auditor can trace and cite: a court exhibit, a cheque, an auditor's report. Not a dashboard.
First surface: the offline evidence pack (READ). Later: dashboard (OPERATE), website (PERSUADE), explainer video; all
inherit this system. Light only for the pack: the use scene is an auditor at a desk or on paper.
Sources: design consultation 2026-10-04 (Fable draft + Astra "The Filed Exhibit" + independent Claude "Chequebook &
Assay Office"); category research: Vanta indigo/purple + Reckless/Inter (vanta.com/brand/colors), SOC 2 reports as
title page + opinion + sections (centraleyes.com, secureframe.com).

## Colors
Restrained. Paper and ink carry everything. Color is rare and always means something:
- **seal** (bronze) appears only on the chain-verification seal.
- **human-approval** (oxblood) appears only where a named human approved a risky call. Automated decisions stay
  monochrome, so color in the pack literally marks a human signature.
- **exception-tint** backs rows for denials/timeouts/anomalies, always with the written decision word.
Every status is also a word; the pack prints correctly in grayscale. Ink on paper 14.9:1, ink-muted 7.3:1.
Never: purple/indigo, gradients, colored left borders, glow.

## Typography
All faces are free under the SIL Open Font License 1.1 (verified 2026-10-04: github.com/adobe-fonts/source-serif,
github.com/IBM/plex, github.com/JetBrains/JetBrainsMono) and are EMBEDDED in the evidence pack (WOFF2, base64, with
license notices) so it stays a single offline file.
- **Source Serif 4** (upright only, no italic display): headings and prose. Auditor's-report authority.
- **IBM Plex Sans Condensed**: tables and form labels. Reads like a bureaucratic form; condensed fits evidence columns.
- **JetBrains Mono**: record ids and hashes, at full size, ligatures off, never shrunk into decoration.
Tabular numerals in all number/time columns. Prose measure ~68ch.
PDF (dependency-free writer, 14 standard fonts): Times-Roman/Times-Bold for prose, Helvetica for tables/labels,
Courier for ids/hashes, until font embedding is added.

## Layout
Grid-disciplined document. Max width 1080px sheet on a surround; 64px sheet padding desktop, 24px mobile.
1. Exhibit cover: flush-left title + entity + scope line; registration block on the right (pack id, period, records,
   policy version + reviewer, mode); no kicker above the title.
2. Integrity block: verification seal + the verbatim chain line + anchor line + full ledger head hash.
3. Numbered sections (1. Summary ... 6. Vocabulary) with numbered tables ("Table 3.1"); records cited as R-0001.
4. Record tables carry a chain margin column: sequence, previous-hash prefix, own-hash prefix, so the chain visibly
   interlocks row to row.
Square corners (rounded 0) everywhere except the round seal. No cards, no nested boxes, no 3-column feature grids.

## Elevation & Depth
Flat. One soft offset shadow on the screen sheet only (removed in print). Ruled lines, not shadows, separate content.

## Shapes
Rectangles and rules. The only circle is the verification seal. Approval marks are square-cornered stamps (not rotated).

## Components
integrity-block, verification-seal, human-approval-mark, table-header (1.5px ink rule), exception-row (tint + word),
registration block (label/value rows), chain margin (dashed rule-strong divider, mono 11.5px).

## Do's and Don'ts
Do: keep every pinned sentence and table column verbatim (docs/slices/slice-1c-pins.md pin 8); show exceptions with the
same typographic weight as successes; print hashes in full; write every status as a word.
Don't: kicker labels above headings, colored side borders, status pills as the only signal, gradients, emoji, icon
tiles, motion (the pack is a document), Inter/Roboto/system fonts as the voice, cream backgrounds, italic display serif.
