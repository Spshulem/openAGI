// Reviewed upstream release. Installer and compatibility tests share this pin;
// upgrades are explicit source changes, never a runtime `latest` lookup.
export const OCU_RELEASE = Object.freeze({
  version: "0.3.3",
  repository: "https://github.com/iFurySt/open-codex-computer-use",
  archive: "https://registry.npmjs.org/open-computer-use/-/open-computer-use-0.3.3.tgz",
  integrity: "A4xCoXgu+Mwi2OdhL15FHY/VcnhhxIJwRgSmC2LwX9mTya85VO2NZN8PNholvgQeTeOlPpej+eEucHXtPhhVrA==",
  license: "MIT"
});

export const OCU_VERSION = OCU_RELEASE.version;
