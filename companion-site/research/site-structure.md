# OpenAGI: agent first

Revised 2026-11-10 in response to the user's direction: make the installable
agent the product, with the personal agent and Supervisor as its core
experiences. Apps, integrations, and hardware extend that agent.

The homepage now leads with "Your agent. Already on it.", a copyable installer,
and clearly labeled software examples. It then covers personal-agent outcomes,
Supervisor, technical differentiation, desktop/mobile/tools, and installation.
Hardware is a small supporting link and a separate field guide.

The install page offers the Mac app, one-command installer, Docker, and source
installation, followed by model setup and a first useful conversation. The
hardware catalogue has been removed from this flow. Shared navigation now
prioritizes Personal agent, Supervisor, Apps & integrations, Technology, and
Install OpenAGI. Hardware remains available through the footer and ecosystem.

## Source checks

- Baseline: https://openagi.sh/ (browser HTML)
- Installer: https://github.com/Spshulem/openAGI/blob/main/scripts/install.sh
- Install guide: https://github.com/Spshulem/openAGI/blob/main/docs/INSTALL.md
- First use: https://github.com/Spshulem/openAGI/blob/main/docs/GETTING_STARTED.md
- Supervisor: https://github.com/Spshulem/openAGI/blob/main/docs/setup/fleet-supervisor.md
- Mobile: https://github.com/Spshulem/openAGI/tree/main/mobile
- Integrations: https://github.com/Spshulem/openAGI/blob/main/docs/setup/partner-and-integrations.md

The Mac download resolved to the v0.0.66 DMG during verification. The site keeps
the stable openagi.sh/download link. Mobile is labeled source / QA builds,
without implying an App Store or Play Store release. Cloud-model data handling
and provider costs are described in the installation FAQ.

## Verification

Browser checked with Paseo and local Chromium. The initial pass covered eight
pages at 1440, 1024, 768, 390, and 320 pixels. Preview tabs, keyboard tab
navigation, clipboard contents for every install method, installation anchors,
mobile navigation, disclosures, and integration filters passed.

A visual tablet review caught a crowded navigation bar. After adjusting the
menu breakpoint, the homepage, installation page, and hardware page passed at
seven widths from 320 to 1440 pixels, including both breakpoint boundaries.
The clipboard fallback was also exercised with clipboard permission denied.
No horizontal overflow, header overlap, or browser script errors remained.
Internal files, images, and fragment links resolve; the linked setup documents
returned HTTP 200.

Screenshots and machine-readable browser results are stored in this directory.
The revision was subsequently staged, verified, and promoted to
https://openagi-hardware.vercel.app/ on 2026-11-10. The public site passed
desktop/mobile browser checks across eight pages; all 44 static files match
the release manifest. See deployment-2026-11-10.json and live-browser-check.json.
No openagi.sh domain or installer changes were made.
