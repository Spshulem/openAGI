import os
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINUX = ROOT / "linux"


class PackagingTests(unittest.TestCase):
    def test_source_tree_contains_no_generated_runtime_or_build_state(self):
        generated = [
            path.relative_to(LINUX).as_posix()
            for path in LINUX.rglob("*")
            if path.is_file()
            and (
                ".cache" in path.relative_to(LINUX).parts
                or "__pycache__" in path.parts
                or path.suffix in {".pyc", ".pyo"}
                or any(part.endswith(".egg-info") for part in path.parts)
            )
        ]
        self.assertEqual(generated, [])

    def test_python_package_exposes_companion_and_one_shot_helper(self):
        with (LINUX / "pyproject.toml").open("rb") as handle:
            project = tomllib.load(handle)["project"]
        self.assertEqual(project["requires-python"], ">=3.11")
        self.assertEqual(
            project["scripts"]["openagi-linux-companion"],
            "openagi_linux.app:main",
        )
        self.assertEqual(
            project["scripts"]["openagi-linux-helper"],
            "openagi_linux.helper:main",
        )

    def test_headless_ci_provisions_native_gstreamer_dependencies(self):
        workflow = (ROOT / ".github" / "workflows" / "linux-companion.yml").read_text(encoding="utf-8")
        installer = (LINUX / "install-user.sh").read_text(encoding="utf-8")

        self.assertIn("runs-on: ubuntu-24.04", workflow)
        for package in (
            "python3-venv",
            "python3-gi",
            "python3-gst-1.0",
            "gir1.2-gst-plugins-base-1.0",
            "gstreamer1.0-plugins-base",
            "libdbus-1-3",
            "libxkbcommon0",
            "tesseract-ocr",
        ):
            self.assertIn(package, workflow)
        self.assertIn("python3 -m venv --system-site-packages .venv", workflow)
        self.assertIn('cp -a linux "$RUNNER_TEMP/openagi-linux-source"', workflow)
        self.assertIn(
            '.venv/bin/python -m pip install --disable-pip-version-check "$RUNNER_TEMP/openagi-linux-source"',
            workflow,
        )
        self.assertNotIn("pip install --disable-pip-version-check ./linux", workflow)
        self.assertIn(".venv/bin/python - <<'PY'", workflow)
        self.assertNotIn("actions/setup-python", workflow)
        self.assertNotIn("--no-deps", installer)
        self.assertIn('"${STAGING_VENV}/bin/python" - <<\'PY\'', installer)

    def test_linux_readme_documents_consent_privacy_and_configuration_contract(self):
        readme = (LINUX / "README.md").read_text(encoding="utf-8")
        root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for required in (
            "Screen capture and remote control are disabled at startup",
            "Observation and Quick Ask frames remain in memory",
            "Computer Use screenshot responses are returned to the OpenAGI core",
            "never stored in the observation outbox",
            "OPENAGI_LINUX_EXCLUDED_APPS",
            "OPENAGI_LINUX_EXCLUDED_TITLE_TERMS",
            "Ctrl+Alt+Space",
            "install-user.sh",
            "durable HOME/NVMe checkout",
            "iMessage",
        ):
            self.assertIn(required, readme)
        self.assertNotIn("No screenshot bytes are sent to OpenAGI.", readme)
        self.assertIn("### Linux desktop companion (KDE Plasma / Wayland)", root_readme)
        self.assertIn("[Linux companion documentation](linux/README.md)", root_readme)

    def test_user_unit_is_bound_to_graphical_session_and_fail_closed(self):
        unit = (LINUX / "systemd" / "openagi-linux-companion.service").read_text(encoding="utf-8")
        installer = (LINUX / "install-user.sh").read_text(encoding="utf-8")
        self.assertIn("PartOf=graphical-session.target", unit)
        self.assertIn("WantedBy=graphical-session.target", unit)
        self.assertIn("ExecStart=%h/.local/bin/openagi-linux-companion", unit)
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertNotIn("OPENAGI_LINUX_RPC_PEER_UNIT", unit)
        self.assertIn('STATE_DIR="${HOME}/.local/state/openagi/linux-companion"', installer)
        self.assertIn("ReadWritePaths=%h/.local/state/openagi/linux-companion %t", unit)
        self.assertIn(
            "Environment=XDG_CONFIG_HOME=%h/.local/state/openagi/linux-companion/config",
            unit,
        )
        self.assertNotIn("Environment=XDG_CONFIG_HOME=%h/.config", unit)
        self.assertIn('install -d -m 0700 "${STATE_DIR}"', installer)
        self.assertIn('DESKTOP_FILE="${DATA_HOME}/applications/sh.openagi.LinuxCompanion.desktop"', installer)
        self.assertIn("busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure", installer)
        self.assertIn("systemctl --user restart openagi-linux-companion.service", installer)
        self.assertNotIn("--enable-capture", unit)
        self.assertNotIn("--enable-control", unit)

    def test_installer_dry_run_targets_home_and_does_not_mutate_it(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as fake_temp:
            home = Path(temp)
            fake_bin = Path(fake_temp)
            systemctl = fake_bin / "systemctl"
            systemctl.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            systemctl.chmod(0o700)
            env = {
                **os.environ,
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / ".config"),
                "XDG_DATA_HOME": str(home / ".local" / "share"),
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
            }
            result = subprocess.run(
                ["bash", str(LINUX / "install-user.sh"), "--dry-run"],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(str(home / ".local" / "share" / "openagi-linux-companion"), result.stdout)
            self.assertIn(str(home / ".config" / "systemd" / "user"), result.stdout)
            self.assertIn("OpenAGI core user service: missing", result.stdout)
            self.assertEqual(list(home.iterdir()), [])

    def test_stage_only_installs_runnable_entrypoints_without_starting_services(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            source_artifacts_before = sorted(LINUX.glob("*.egg-info"))
            env = {
                **os.environ,
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / ".config"),
                "XDG_DATA_HOME": str(home / ".local" / "share"),
            }
            result = subprocess.run(
                ["bash", str(LINUX / "install-user.sh"), "--stage-only"],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=120,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            companion = home / ".local" / "bin" / "openagi-linux-companion"
            helper = home / ".local" / "bin" / "openagi-linux-helper"
            self.assertTrue(companion.is_symlink())
            self.assertTrue(helper.is_symlink())
            version = subprocess.run(
                [str(companion), "--version"],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual((version.returncode, version.stdout.strip()), (0, "0.1.0"), version.stderr)
            self.assertTrue((home / ".config" / "systemd" / "user" / "openagi-linux-companion.service").is_file())
            desktop_file = home / ".local" / "share" / "applications" / "sh.openagi.LinuxCompanion.desktop"
            self.assertTrue(desktop_file.is_file())
            desktop = desktop_file.read_text(encoding="utf-8")
            self.assertIn("Type=Application", desktop)
            self.assertIn("Exec=openagi-linux-companion", desktop)
            dropin = (home / ".config" / "systemd" / "user" / "openagi.service.d" / "20-linux-companion.conf").read_text(encoding="utf-8")
            self.assertIn("[Unit]\nAfter=graphical-session.target", dropin)
            self.assertEqual(sorted(LINUX.glob("*.egg-info")), source_artifacts_before)

    def test_failed_upgrade_preserves_existing_environment_and_entrypoints(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as fake_temp:
            home = Path(temp)
            fake_bin = Path(fake_temp)
            install_root = home / ".local" / "share" / "openagi-linux-companion"
            old_bin = install_root / "venv" / "bin"
            command_dir = home / ".local" / "bin"
            old_bin.mkdir(parents=True)
            command_dir.mkdir(parents=True)
            old_companion = old_bin / "openagi-linux-companion"
            old_helper = old_bin / "openagi-linux-helper"
            old_companion.write_text("old companion\n", encoding="utf-8")
            old_helper.write_text("old helper\n", encoding="utf-8")
            companion_link = command_dir / "openagi-linux-companion"
            helper_link = command_dir / "openagi-linux-helper"
            companion_link.symlink_to(old_companion)
            helper_link.symlink_to(old_helper)
            old_targets = (os.readlink(companion_link), os.readlink(helper_link))

            python3 = fake_bin / "python3"
            python3.write_text(
                "#!/usr/bin/env bash\n"
                "if [[ \"${1:-}\" == '-m' && \"${2:-}\" == 'venv' ]]; then\n"
                "  target=\"${@: -1}\"\n"
                "  rm -rf -- \"${target}\"\n"
                "  mkdir -p -- \"${target}/bin\"\n"
                "  printf '#!/usr/bin/env bash\\nexit 73\\n' >\"${target}/bin/python\"\n"
                "  chmod 0700 \"${target}/bin/python\"\n"
                "  exit 0\n"
                "fi\n"
                f"exec {sys.executable!s} \"$@\"\n",
                encoding="utf-8",
            )
            python3.chmod(0o700)
            env = {
                **os.environ,
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / ".config"),
                "XDG_DATA_HOME": str(home / ".local" / "share"),
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
            }

            result = subprocess.run(
                ["bash", str(LINUX / "install-user.sh"), "--stage-only"],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(old_companion.read_text(encoding="utf-8"), "old companion\n")
            self.assertEqual(old_helper.read_text(encoding="utf-8"), "old helper\n")
            self.assertEqual((os.readlink(companion_link), os.readlink(helper_link)), old_targets)
            releases = install_root / "releases"
            self.assertEqual(list(releases.iterdir()) if releases.exists() else [], [])

    def _assert_activation_failure_rolls_back_release_entrypoints_and_service_files(self, failure_mode):
        self.assertIn(failure_mode, {"activation", "health"})
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as fake_temp:
            home = Path(temp)
            fake_bin = Path(fake_temp)
            data_home = home / ".local" / "share"
            config_home = home / ".config"
            install_root = data_home / "openagi-linux-companion"
            releases = install_root / "releases"
            old_release = releases / "release.old"
            old_bin = old_release / "venv" / "bin"
            command_dir = home / ".local" / "bin"
            systemd_dir = config_home / "systemd" / "user"
            dropin = systemd_dir / "openagi.service.d" / "20-linux-companion.conf"
            unit = systemd_dir / "openagi-linux-companion.service"
            desktop = data_home / "applications" / "sh.openagi.LinuxCompanion.desktop"
            kwin = data_home / "kwin" / "scripts" / "openagi-linux-companion"
            kwin_config = config_home / "kwinrc"
            for directory in (old_bin, command_dir, dropin.parent, desktop.parent, kwin / "contents" / "code"):
                directory.mkdir(parents=True, exist_ok=True)
            for name in ("openagi-linux-companion", "openagi-linux-helper"):
                executable = old_bin / name
                executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                executable.chmod(0o700)
                (command_dir / name).symlink_to(install_root / "current" / "venv" / "bin" / name)
            (install_root / "current").symlink_to("releases/release.old")
            unit.write_text("old unit\n", encoding="utf-8")
            dropin.write_text("old dropin\n", encoding="utf-8")
            desktop.write_text("old desktop\n", encoding="utf-8")
            kwin_config.write_text("old kwin config\n", encoding="utf-8")
            (kwin / "metadata.json").write_text("old metadata\n", encoding="utf-8")
            (kwin / "contents" / "code" / "main.js").write_text("old script\n", encoding="utf-8")

            python3 = fake_bin / "python3"
            python3.write_text(
                "#!/usr/bin/env bash\n"
                "if [[ \"${1:-}\" == '-m' && \"${2:-}\" == 'venv' ]]; then\n"
                "  target=\"${@: -1}\"\n"
                "  mkdir -p -- \"${target}/bin\"\n"
                "  cat >\"${target}/bin/python\" <<'PY'\n"
                "#!/usr/bin/env bash\n"
                "if [[ \"${1:-}\" == '-m' && \"${2:-}\" == 'pip' ]]; then\n"
                "  bindir=\"$(dirname \"$0\")\"\n"
                "  printf '#!/bin/sh\\n[ \"$1\" = --version ] && echo 0.1.0\\nexit 0\\n' >\"${bindir}/openagi-linux-companion\"\n"
                f"  printf '#!/bin/sh\\nexit {72 if failure_mode == 'health' else 0}\\n' >\"${{bindir}}/openagi-linux-helper\"\n"
                "  chmod 0700 \"${bindir}/openagi-linux-companion\" \"${bindir}/openagi-linux-helper\"\n"
                "fi\n"
                "exit 0\n"
                "PY\n"
                "  chmod 0700 \"${target}/bin/python\"\n"
                "  exit 0\n"
                "fi\n"
                f"exec {sys.executable!s} \"$@\"\n",
                encoding="utf-8",
            )
            python3.chmod(0o700)
            systemctl = fake_bin / "systemctl"
            failure_marker = fake_bin / "failed-once"
            enabled_state = fake_bin / "companion-enabled"
            companion_state = fake_bin / "companion-active"
            core_state = fake_bin / "core-active"
            systemctl_log = fake_bin / "systemctl.log"
            for state_file in (enabled_state, companion_state, core_state):
                state_file.write_text("1\n", encoding="utf-8")
            activation_failure = ""
            if failure_mode == "activation":
                activation_failure = (
                    "if [[ \"${args}\" == *'restart openagi-linux-companion.service'* && ! -e "
                    f"{failure_marker!s}" " ]]; then\n"
                    f"  printf '0\\n' >{companion_state!s}\n"
                    f"  touch {failure_marker!s}\n"
                    "  exit 71\n"
                    "fi\n"
                )
            systemctl.write_text(
                "#!/usr/bin/env bash\n"
                "args=\"$*\"\n"
                f"printf '%s\\n' \"${{args}}\" >>{systemctl_log!s}\n"
                f"if [[ \"${{args}}\" == *'is-enabled openagi-linux-companion.service'* ]]; then [[ \"$(cat {enabled_state!s})\" == 1 ]]; exit; fi\n"
                f"if [[ \"${{args}}\" == *'is-active'* && \"${{args}}\" == *'openagi-linux-companion.service'* ]]; then [[ \"$(cat {companion_state!s})\" == 1 ]]; exit; fi\n"
                f"if [[ \"${{args}}\" == *'is-active'* && \"${{args}}\" == *'openagi.service'* ]]; then [[ \"$(cat {core_state!s})\" == 1 ]]; exit; fi\n"
                f"if [[ \"${{args}}\" == *'stop openagi-linux-companion.service'* ]]; then printf '0\\n' >{companion_state!s}; exit 0; fi\n"
                f"if [[ \"${{args}}\" == *'enable openagi-linux-companion.service'* ]]; then printf '1\\n' >{enabled_state!s}; exit 0; fi\n"
                f"if [[ \"${{args}}\" == *'disable openagi-linux-companion.service'* ]]; then printf '0\\n' >{enabled_state!s}; exit 0; fi\n"
                + activation_failure
                + f"if [[ \"${{args}}\" == *'restart openagi-linux-companion.service'* || \"${{args}}\" == *'start openagi-linux-companion.service'* ]]; then printf '1\\n' >{companion_state!s}; exit 0; fi\n"
                f"if [[ \"${{args}}\" == *'restart openagi.service'* ]]; then printf '1\\n' >{core_state!s}; exit 0; fi\n"
                "exit 0\n",
                encoding="utf-8",
            )
            systemctl.chmod(0o700)
            kwriteconfig = fake_bin / "kwriteconfig6"
            kwriteconfig.write_text(
                "#!/bin/sh\nprintf 'mutated kwin config\\n' >\"${XDG_CONFIG_HOME}/kwinrc\"\nexit 0\n",
                encoding="utf-8",
            )
            kwriteconfig.chmod(0o700)
            for command in ("kreadconfig6", "qdbus6", "busctl", "sleep"):
                executable = fake_bin / command
                executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                executable.chmod(0o700)
            env = {
                **os.environ,
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(config_home),
                "XDG_DATA_HOME": str(data_home),
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
            }

            result = subprocess.run(
                ["bash", str(LINUX / "install-user.sh")],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                check=False,
            )

            self.assertEqual(
                result.returncode,
                71 if failure_mode == "activation" else 1,
                (result.stdout, result.stderr),
            )
            self.assertEqual(os.readlink(install_root / "current"), "releases/release.old")
            self.assertEqual(sorted(path.name for path in releases.iterdir()), ["release.old"])
            self.assertEqual(unit.read_text(encoding="utf-8"), "old unit\n")
            self.assertEqual(dropin.read_text(encoding="utf-8"), "old dropin\n")
            self.assertEqual(desktop.read_text(encoding="utf-8"), "old desktop\n")
            self.assertEqual(kwin_config.read_text(encoding="utf-8"), "old kwin config\n")
            self.assertEqual((kwin / "metadata.json").read_text(encoding="utf-8"), "old metadata\n")
            self.assertEqual((kwin / "contents" / "code" / "main.js").read_text(encoding="utf-8"), "old script\n")
            for name in ("openagi-linux-companion", "openagi-linux-helper"):
                self.assertEqual(
                    os.readlink(command_dir / name),
                    str(install_root / "current" / "venv" / "bin" / name),
                )
            self.assertEqual(enabled_state.read_text(encoding="utf-8"), "1\n")
            self.assertEqual(companion_state.read_text(encoding="utf-8"), "1\n")
            self.assertEqual(core_state.read_text(encoding="utf-8"), "1\n")
            systemctl_calls = systemctl_log.read_text(encoding="utf-8")
            self.assertIn("stop openagi-linux-companion.service", systemctl_calls)
            self.assertIn("enable openagi-linux-companion.service", systemctl_calls)
            self.assertIn("start openagi-linux-companion.service", systemctl_calls)
            self.assertIn("restart openagi.service", systemctl_calls)

    def test_activation_failure_rolls_back_release_entrypoints_and_service_files(self):
        self._assert_activation_failure_rolls_back_release_entrypoints_and_service_files("activation")

    def test_health_failure_rolls_back_release_entrypoints_and_service_files(self):
        self._assert_activation_failure_rolls_back_release_entrypoints_and_service_files("health")

    def test_activation_refuses_missing_core_service_before_mutating_home(self):
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as fake_temp:
            home = Path(temp)
            fake_bin = Path(fake_temp)
            systemctl = fake_bin / "systemctl"
            systemctl.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            systemctl.chmod(0o700)
            env = {
                **os.environ,
                "HOME": str(home),
                "XDG_CONFIG_HOME": str(home / ".config"),
                "XDG_DATA_HOME": str(home / ".local" / "share"),
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
            }

            result = subprocess.run(
                ["bash", str(LINUX / "install-user.sh")],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30,
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("Missing OpenAGI core user service", result.stderr)
            self.assertEqual(list(home.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
