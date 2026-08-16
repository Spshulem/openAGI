import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(
  path.join(REPO, ".github/workflows/release-mac.yml"),
  "utf8"
);

test("manual Mac workflow produces a notarized artifact without publishing a release", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /GITHUB_EVENT_NAME.*push.*GITHUB_REF_TYPE.*tag/,
    "manual dispatches must remain non-publishing even when a tag ref is selected"
  );
  assert.match(workflow, /PUBLISH="false"/);
  assert.match(workflow, /DMG="0"/);
  assert.match(workflow, /xcrun stapler validate build\/OpenAGI\.app/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/);

  const publishGuards = workflow.match(/if: steps\.ver\.outputs\.publish == 'true'/g) || [];
  assert.equal(
    publishGuards.length,
    2,
    "both appcast generation and GitHub Release upload must remain tag-only"
  );
});

test("the build script notarizes an accepted container and staples the app", () => {
  const buildScript = fs.readFileSync(
    path.join(REPO, "scripts/build-mac-app.sh"),
    "utf8"
  );

  assert.match(buildScript, /OpenAGI-\$\{VERSION\}-notarization\.zip/);
  assert.match(buildScript, /ditto -c -k --sequesterRsrc --keepParent/);
  assert.match(buildScript, /STAPLE_TARGET="\$\{APP\}"/);
  assert.match(buildScript, /xcrun stapler validate "\$\{STAPLE_TARGET\}"/);
  assert.match(buildScript, /spctl --assess --type "\$\{ASSESS_TYPE\}"/);
  assert.match(buildScript, /AC_KEYCHAIN_PROFILE/);
  assert.match(buildScript, /-n "\$\{AC_PASSWORD:-\}"/);
});
