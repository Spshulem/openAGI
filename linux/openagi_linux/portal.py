from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image

from .capture import FocusSnapshot, Frame


@dataclass(frozen=True)
class PortalStream:
    node_id: int
    position: tuple[int, int]
    logical_size: tuple[int, int]
    source_type: int
    mapping_id: str | None = None
    pipewire_serial: int | None = None


@dataclass(frozen=True)
class PortalStartResult:
    stream: PortalStream
    restore_token: str | None


def parse_start_result(raw: dict) -> PortalStartResult:
    value = _unbox(raw)
    streams = value.get("streams") if isinstance(value, dict) else None
    if not isinstance(streams, (list, tuple)) or len(streams) != 1:
        raise ValueError("portal must return exactly one stream")
    stream_value = streams[0]
    if not isinstance(stream_value, (list, tuple)) or len(stream_value) != 2:
        raise ValueError("portal returned a malformed stream")
    node_id = _strict_int(stream_value[0], "stream node id")
    props = _unbox(stream_value[1])
    if not isinstance(props, dict):
        raise ValueError("portal returned malformed stream properties")
    position = _pair(props.get("position", (0, 0)), "position")
    size = _pair(props.get("size"), "size")
    source_type = _strict_int(props.get("source_type", 0), "stream source type")
    if node_id <= 0 or size[0] <= 0 or size[1] <= 0 or source_type not in {1, 2, 4}:
        raise ValueError("portal returned an unusable stream")
    mapping_id = _unbox(props.get("mapping_id"))
    if mapping_id is not None:
        if type(mapping_id) is not str or not mapping_id or len(mapping_id) > 500:
            raise ValueError("portal returned an invalid mapping id")
    raw_serial = _unbox(props.get("pipewire-serial", props.get("pipewire_serial")))
    pipewire_serial = _strict_int(raw_serial, "returned an invalid PipeWire serial") if raw_serial is not None else None
    if pipewire_serial is not None and pipewire_serial <= 0:
        raise ValueError("portal returned an invalid PipeWire serial")
    restore_token = _unbox(value.get("restore_token"))
    if restore_token is not None:
        if type(restore_token) is not str or not restore_token or len(restore_token) > 16_384:
            raise ValueError("portal returned an invalid restore token")
    return PortalStartResult(
        stream=PortalStream(
            node_id=node_id,
            position=position,
            logical_size=size,
            source_type=source_type,
            mapping_id=mapping_id,
            pipewire_serial=pipewire_serial,
        ),
        restore_token=restore_token,
    )


def crop_logical_window(png: bytes, stream: PortalStream, focus: FocusSnapshot) -> Frame:
    if not isinstance(png, bytes) or len(png) > 32 * 1024 * 1024:
        raise ValueError("portal frame is invalid")
    try:
        image = Image.open(io.BytesIO(png))
        image.load()
    except Exception as error:
        raise ValueError("portal frame is not a readable image") from error
    monitor_x, monitor_y = stream.position
    logical_width, logical_height = stream.logical_size
    focus_right = focus.x + focus.width
    focus_bottom = focus.y + focus.height
    monitor_right = monitor_x + logical_width
    monitor_bottom = monitor_y + logical_height
    if (
        focus.x < monitor_x
        or focus.y < monitor_y
        or focus_right > monitor_right
        or focus_bottom > monitor_bottom
    ):
        raise ValueError("focused window is outside the selected portal stream")
    scale_x = image.width / logical_width
    scale_y = image.height / logical_height
    left = round((focus.x - monitor_x) * scale_x)
    top = round((focus.y - monitor_y) * scale_y)
    right = round((focus_right - monitor_x) * scale_x)
    bottom = round((focus_bottom - monitor_y) * scale_y)
    if left < 0 or top < 0 or right > image.width or bottom > image.height or right - left < 32 or bottom - top < 32:
        raise ValueError("focused window crop is invalid")
    cropped = image.convert("RGBA").crop((left, top, right, bottom))
    output = io.BytesIO()
    cropped.save(output, format="PNG", optimize=True)
    return Frame(png=output.getvalue(), width=cropped.width, height=cropped.height)


def _pair(value, label: str) -> tuple[int, int]:
    raw = _unbox(value)
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        raise ValueError(f"portal stream {label} is invalid")
    return (
        _strict_int(raw[0], f"stream {label}"),
        _strict_int(raw[1], f"stream {label}"),
    )


def _strict_int(value, label: str) -> int:
    raw = _unbox(value)
    if type(raw) is not int:
        raise ValueError(f"portal {label} is invalid")
    return raw


def _unbox(value):
    while hasattr(value, "unpack"):
        value = value.unpack()
    if isinstance(value, dict):
        return {str(key): _unbox(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_unbox(item) for item in value)
    return value
