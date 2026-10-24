import urllib.request
import json
from pathlib import Path

sample = Path("backend/samples/tts/s02_volume_hinglish.wav")
boundary = "WebKitFormBoundary7MA4YWxkTrZu0gW"
data = sample.read_bytes()

body = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="file"; filename="s02.wav"\r\n'
    f"Content-Type: audio/wav\r\n\r\n"
).encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")

req = urllib.request.Request(
    "http://127.0.0.1:8000/api/transcribe",
    data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
)

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        print("Response:", resp.read().decode())
except urllib.error.HTTPError as e:
    print("HTTP Error:", e.code, e.read().decode())
except Exception as e:
    print("Error:", e)
