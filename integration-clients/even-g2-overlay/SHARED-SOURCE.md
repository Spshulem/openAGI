# Reproducible client inputs

Shared helpers retain their original BuildBetter G2 names and implementation.
This is a frozen source snapshot from the assembled 0.4.17 verification client,
not an upstream release or a claim that the independent G2 repo contains it.
The exact inputs are now checked in: no dirty workspace or moving branch is needed.

The standalone entry is src/openagi-main.ts. The older src/main.ts remains an
overlay entry for compatible combined clients, excluded from this build.
The lockfile pins the dependency graph, including Even SDK 0.0.15.
Use pnpm install --frozen-lockfile, then pnpm test and pnpm package:agents.
Shared-input or SDK upgrades require client regressions and physical testing.

Original SHA-256 values:

```text
ccffef4b87e2b067a828a97f5ba176296a96de60bdc22613fe8dd8134af1f2ef  src/even/audio-source.ts
77c94be7c71ee6851b4d376d23c7158f979d18ef70e05e92c12ad7d4c7636244  src/even/input-controller.ts
58a7254832bc5a76de10f689fc0fb0909a9c3a188e0367f8153c7c04b4d3dfe7  src/even/display-controller.ts
a0b6b3b9d78fba13c2391b589e1f4cc389f9aa8b8ebeba8e57b263469f2002dc  src/storage/recovery-store.ts
99b1da751d33e8533cdcbee99a409e7bf1e5e47291881949697f97e279ebe4a6  src/buildbetter/question-audio.ts
b1497522366643264d6b92973c7132a303ade2d40f12609d381cb237a8257598  src/buildbetter/audio-frame.ts
737b4eb5f06754b1715ac289ca6d02cb520718e7eec0bc290ff696f2b395b167  src/state/ask-state-machine.ts
6e28827868c4aa636ca97683489a0b065ff4bd0c077af441f4831158d581fe9c  pnpm-lock.yaml
```
