// test/install-image-pin.test.js
//
// Regression test for the container supply chain.
//
// What actually happened: scripts/install.sh, docker-compose.example.yml and
// the Dockerfile header all told users to run `openagi/openagi:latest`.
// hub.docker.com/v2/repositories/openagi/openagi/ returns
// {"message":"object not found"} — that Docker Hub namespace is UNOWNED, while
// .github/workflows/docker.yml publishes to ghcr.io/<repo>. So the documented
// install was already broken, and whoever claimed the namespace first would own
// every Docker install: scripts/update.sh runs `docker compose pull`
// unattended and the README recommends Watchtower.
//
// Two invariants, both checked against the files that actually run:
//   1. no shipped install path may name a registry CI does not publish to;
//   2. anything an unattended updater re-pulls must be pinned to an immutable
//      version tag, not a floating :latest.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// What .github/workflows/docker.yml actually pushes: ghcr.io/${GITHUB_REPOSITORY,,}
// — the ,, is bash lowercasing, so Spshulem/openAGI becomes spshulem/openagi.
const PUBLISHED_REGISTRY = "ghcr.io/spshulem/openagi";

// Every file a user's install actually executes.
const INSTALL_ARTIFACTS = [
  "Dockerfile",
  "docker-compose.example.yml",
  "scripts/install.sh",
  "scripts/update.sh",
];

test("CI still publishes to the registry the install artifacts point at", () => {
  const wf = read(".github/workflows/docker.yml");
  assert.match(wf, /ghcr\.io\/\$\{REPO\}/, "docker.yml must still publish to ghcr.io/<repo>");
  assert.match(wf, /REPO=\$\{GITHUB_REPOSITORY,,\}/, "docker.yml must still lowercase the repo — that is why the path is spshulem/openagi");
});

// Prose explaining WHY we abandoned the namespace is fine and worth keeping;
// what must not survive is any line that actually pulls or runs it.
const stripComments = (body) =>
  body.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("no shipped install path pulls or runs the unowned openagi/openagi Docker Hub namespace", () => {
  for (const rel of INSTALL_ARTIFACTS) {
    assert.doesNotMatch(
      stripComments(read(rel)),
      /(^|[^.\w/])openagi\/openagi\b/m,
      `${rel} still points at the unowned Docker Hub namespace openagi/openagi`
    );
  }
});

test("the install artifacts name the registry CI publishes to", () => {
  for (const rel of ["Dockerfile", "docker-compose.example.yml", "scripts/install.sh"]) {
    assert.ok(
      read(rel).includes(PUBLISHED_REGISTRY),
      `${rel} must reference ${PUBLISHED_REGISTRY}`
    );
  }
});

test("compose images an unattended `docker compose pull` re-pulls are pinned, never :latest", () => {
  // docker-compose.example.yml ships a concrete pinned tag.
  const compose = read("docker-compose.example.yml");
  const openagiImage = /^\s*image:\s*(\S*openagi\S*)\s*$/m.exec(compose);
  assert.ok(openagiImage, "docker-compose.example.yml must declare an openagi image");
  assert.match(
    openagiImage[1],
    new RegExp(`^${PUBLISHED_REGISTRY.replace(/[.\/]/g, "\\$&")}:v\\d+\\.\\d+\\.\\d+$`),
    `docker-compose.example.yml must pin an immutable version tag, got ${openagiImage[1]}`
  );

  // install.sh writes the compose file update.sh later pulls; its default tag
  // must be a version, not a floating one.
  const install = read("scripts/install.sh");
  const defaultTag = /OPENAGI_IMAGE_TAG:-(v\d+\.\d+\.\d+)\}/.exec(install)
    || /DEFAULT_IMAGE_TAG="(v\d+\.\d+\.\d+)"/.exec(install);
  assert.ok(defaultTag, "scripts/install.sh must default to a concrete vX.Y.Z image tag");
  assert.doesNotMatch(
    install,
    /image:\s*\S+:latest/,
    "scripts/install.sh must not write a floating :latest into the compose file update.sh pulls"
  );
});

test("the generated compose file sets an auth token — HOST 0.0.0.0 without one now refuses to boot", () => {
  const install = read("scripts/install.sh");
  assert.match(install, /OPENAGI_AUTH_TOKEN/, "install.sh must put a token in the compose environment block");
  // And it must be generated, not left blank for the user to forget.
  assert.match(install, /openssl rand|\/dev\/urandom|randomBytes/, "install.sh must GENERATE a strong token");
});
