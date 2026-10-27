#!/usr/bin/env python3
"""Seed one generated red/blue image into an explicitly selected CI simulator."""

import argparse
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path


def synthetic_png():
    width = height = 160

    def chunk(kind, payload):
        data = kind + payload
        return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data))

    pixels = b"".join(
        b"\0" + bytes((255, 0, 0) if y < height // 2 else (0, 0, 255)) * width
        for y in range(height)
    )
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("simulator_id")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="openagi-ci-photo-") as directory:
        image = Path(directory) / "synthetic-red-blue.png"
        image.write_bytes(synthetic_png())
        subprocess.run(["xcrun", "simctl", "addmedia", args.simulator_id, str(image)], check=True)
