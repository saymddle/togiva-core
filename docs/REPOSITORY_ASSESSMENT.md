# Repository assessment (Phase 0)

Assessed 2026-11-25.

## What exists

| Repository | Access | State | Role in the ecosystem |
| --- | --- | --- | --- |
| `saymddle/togiva-core` | read/write (project repo) | Empty, no commits | Reusable platform: database, API, auth, loyalty, POS. This repository. |
| `saymddle/mr-cow-applications` | read/write (project repo) | Empty, no commits | Mr. Cow customer PWA, franchise portal, corporate console. |
| `saymddle/Mr-Cow` | read (attached per session, **not** in the project's repository list) | Static marketing website, 1 commit on `main` ("Bold redesign of the Mr. Cow website (#2)") | Brand source of truth. Preserve as is. |

Nothing existed to migrate or preserve in the two new repositories, so there was no risk of overwriting working code.

## Existing Mr. Cow website (`saymddle/Mr-Cow`)

Plain static HTML/CSS in `website/`, built by `node website/build.mjs` from `website/src/` (no dependencies). Six pages: Home, About, Menu, Locations, Franchise inquiry, Contact. It is a redesign of mrcowcorndog.com.

Brand identity found in `website/src/style.css` and `website/src/layout.html`:

| Token | Value | Use on the site |
| --- | --- | --- |
| `--orange` | `#E2592A` | Menu board orange, primary band colour |
| `--yellow` | `#F2C83D` | Filling banner yellow |
| `--gold` | `#E8A83A` | Price pills |
| `--cream` | `#FAE8D2` | Page background, menu cards |
| `--ink` | `#15100D` | Warm black text and bands |
| `--ink-2` | `#2A211B` | Secondary dark |
| `--white` | `#FFFDF8` | Off-white |
| Display font | Archivo 900, `font-stretch: 125%`, uppercase, tight leading | Headlines |
| Body font | Bricolage Grotesque | Body copy |
| Script font | Sacramento | Rotated "sticker" accents |
| Radius / shadow | `28px`, hard offset `6px 6px 0 ink` | Cards and buttons |

Assets: `website/img/logo.webp`, `website/img/cow-badge.webp`, and food cutouts (`classic.webp`, `cheesy-cheeto.webp`, `flaming-cheetah.webp`, etc.).
Contrast rule from its README: every band pairs one background with one fixed text colour (ink on orange/yellow/cream; cream or yellow on ink).

These belong in `mr-cow-applications/packages/brand-config`, never in TOGIVA Core.

Things the website itself flags as unverified: store addresses and hours are not on the current site; drink prices are missing. Do not treat its store list as authoritative location data.

## Reusable functionality

None in code. The website's design tokens and assets are reusable for the PWA's brand layer.

## Missing access

- `saymddle/Mr-Cow` is not in this project's configured repositories. It can be attached per session (read). Add it to the project if every thread should see it.
- No Supabase project, staging/production database, or deployment target is configured for TOGIVA Core yet.
- No Clover developer/sandbox credentials. The POS work cannot verify Clover capabilities without them.

## Recommended setup plan (followed)

1. `togiva-core`: pnpm + Turborepo TypeScript monorepo. Postgres schema in plain, forward-only SQL migrations; Fastify modular-monolith API; Postgres-backed job queue. Supabase as the initial Postgres + Auth host, used only through portable interfaces.
2. Commit contracts (schema, shared types, OpenAPI v1, ownership map) before client work is parallelized.
3. `mr-cow-applications`: three apps consuming `@togiva/api-contracts` and `@togiva/shared-types`, brand tokens from the Mr-Cow website.
