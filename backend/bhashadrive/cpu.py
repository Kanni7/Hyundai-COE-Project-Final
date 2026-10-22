"""Keep the inference threads on the fast cores of hybrid CPUs.

ONNX Runtime and llama.cpp split each step over several threads and wait for the slowest. On a hybrid CPU
(Intel P/E cores, ARM big.LITTLE) the OS may put some of those threads on efficiency cores, and every step
then runs at their speed: on an i7-13650HX the Hinglish Whisper decode took 3.4 s scheduled freely and 1.4 s
pinned to the performance cores. On CPUs whose cores are all alike this does nothing.
"""
from __future__ import annotations

import sys
from pathlib import Path


def _windows_performance_cpus() -> list[int]:
    """Logical processors of the highest efficiency class, from GetSystemCpuSetInformation."""
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.GetSystemCpuSetInformation.argtypes = [ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG),
                                            wintypes.HANDLE, wintypes.ULONG]
    k.GetSystemCpuSetInformation.restype = wintypes.BOOL
    size = wintypes.ULONG(0)
    k.GetSystemCpuSetInformation(None, 0, ctypes.byref(size), None, 0)
    buf = ctypes.create_string_buffer(size.value)
    if not k.GetSystemCpuSetInformation(buf, size, ctypes.byref(size), None, 0):
        return []
    raw, cpus, off = buf.raw, [], 0
    while off < size.value:
        entry_size = int.from_bytes(raw[off:off + 4], "little")
        if entry_size == 0:
            break
        group = int.from_bytes(raw[off + 12:off + 14], "little")
        # SYSTEM_CPU_SET_INFORMATION.CpuSet: LogicalProcessorIndex at +14, EfficiencyClass at +18.
        if group == 0:
            cpus.append((raw[off + 18], raw[off + 14]))
        off += entry_size
    if len({cls for cls, _ in cpus}) < 2:
        return []
    best = max(cls for cls, _ in cpus)
    return sorted(i for cls, i in cpus if cls == best)


def _linux_performance_cpus() -> list[int]:
    """CPUs with the highest maximum frequency (big cores of big.LITTLE)."""
    freq = {}
    for p in Path("/sys/devices/system/cpu").glob("cpu[0-9]*/cpufreq/cpuinfo_max_freq"):
        freq[int(p.parent.parent.name[3:])] = int(p.read_text().strip())
    if len(set(freq.values())) < 2:
        return []
    top = max(freq.values())
    return sorted(c for c, f in freq.items() if f == top)


def pin_to_performance_cores() -> list[int]:
    """Restrict this process to the performance cores; returns them ([] = not a hybrid CPU, or unsupported)."""
    try:
        cpus = _windows_performance_cpus() if sys.platform == "win32" else _linux_performance_cpus()
        if cpus:
            import psutil

            psutil.Process().cpu_affinity(cpus)
        return cpus
    except Exception as exc:  # an optimisation only: never stop the server for it
        print(f"[NOTE] could not pin to performance cores: {exc}")
        return []
